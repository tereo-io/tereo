import { bucketRateLimit } from "../../middleware/bucketRateLimit.js";
import { bucketCors } from "../../middleware/bucketCors.js";
import type { Request, Response } from "express";
import db from "../../utils/db/index.js";
import {
  broadcastBucketInvalidate,
  closeCacheBroadcast,
  onBucketInvalidate,
  startCacheSubscriber,
} from "../../utils/cacheBroadcast.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const fakeRes = () => {
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader: (k: string, v: unknown) => {
      headers[k.toLowerCase()] = v;
    },
    removeHeader: (k: string) => {
      delete headers[k.toLowerCase()];
    },
    status: () => res,
    end: () => {},
  } as unknown as Response;
  return { res, headers };
};

const ORIGIN = "https://new.example";

const fakeReq = (name: string) =>
  ({
    params: { name },
    headers: { origin: ORIGIN },
    method: "GET",
    ip: "203.0.113.1",
  }) as unknown as Request;

const corsConfig = (origin: string) => ({
  allowedOrigins: [origin],
  allowedMethods: ["GET"],
  allowedHeaders: [],
  maxAgeSeconds: 60,
  allowCredentials: false,
});

// 1 token, each request costs 1, refill negligible: the 2nd request is refused.
const oneRequestLimit = {
  tokensPerSecond: 0.001,
  maxTokens: 1,
  requestCost: 1,
};

const randomBucketId = () => 900_000_000 + Math.floor(Math.random() * 1e8);

/** Sends three requests and returns how many the bucket limit refused. */
const refusedOfThree = async (name: string) => {
  const errors: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    await bucketRateLimit(fakeReq(name), fakeRes().res, (err?: unknown) => {
      if (err) errors.push(err);
    });
  }
  return errors.length;
};

/** Resolves once this process has received an invalidation for `name`. */
const invalidationArrived = (name: string) => {
  const seen = deferred<void>();
  onBucketInvalidate((n) => {
    if (n === name) seen.resolve();
  });
  return seen.promise;
};

const invalidate = async (name: string) => {
  const arrived = invalidationArrived(name);
  await broadcastBucketInvalidate(name);
  await arrived;
};

describe("bucket CORS and rate-limit config caches", () => {
  beforeAll(async () => {
    await startCacheSubscriber();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeCacheBroadcast();
  });

  describe("a lookup that read the bucket before an invalidation", () => {
    it("does not cache the old CORS config", async () => {
      const name = `race-cors-${Date.now()}`;
      const oldRead = deferred<unknown>();
      const spy = vi
        .spyOn(db.buckets, "checkByName")
        .mockImplementationOnce(() => oldRead.promise as never);

      const pending = bucketCors(fakeReq(name), fakeRes().res, () => {});
      await invalidate(name);
      oldRead.resolve({ id: 1, corsConfig: corsConfig("https://old.example") });
      await pending;

      spy.mockImplementation(
        async () => ({ id: 1, corsConfig: corsConfig(ORIGIN) }) as never
      );
      const { res, headers } = fakeRes();
      await bucketCors(fakeReq(name), res, () => {});
      expect(headers["access-control-allow-origin"]).toBe(ORIGIN);
    });

    it("does not cache the old rate limit", async () => {
      const name = `race-rl-${Date.now()}`;
      const bucketId = randomBucketId();
      const oldRead = deferred<unknown>();
      const spy = vi
        .spyOn(db.buckets, "checkByName")
        .mockImplementationOnce(() => oldRead.promise as never);

      const pending = bucketRateLimit(fakeReq(name), fakeRes().res, () => {});
      await invalidate(name);
      oldRead.resolve({ id: bucketId, rateLimitConfig: null });
      await pending;

      spy.mockImplementation(
        async () =>
          ({ id: bucketId, rateLimitConfig: oneRequestLimit }) as never
      );
      expect(await refusedOfThree(name)).toBe(2);
    });
  });

  describe("a name with no bucket", () => {
    it("is remembered for seconds, not as a bucket without CORS", async () => {
      const name = `missing-cors-${Date.now()}`;
      const spy = vi
        .spyOn(db.buckets, "checkByName")
        .mockResolvedValue(null as never);

      await bucketCors(fakeReq(name), fakeRes().res, () => {});
      await bucketCors(fakeReq(name), fakeRes().res, () => {});
      expect(spy).toHaveBeenCalledTimes(1);

      // The bucket is created; past the short TTL its config is read.
      spy.mockResolvedValue({ id: 1, corsConfig: corsConfig(ORIGIN) } as never);
      const later = Date.now() + 6_000;
      vi.spyOn(Date, "now").mockReturnValue(later);
      const { res, headers } = fakeRes();
      await bucketCors(fakeReq(name), res, () => {});
      expect(headers["access-control-allow-origin"]).toBe(ORIGIN);
    });

    it("is forgotten on the bucket's invalidation", async () => {
      const name = `missing-cors-inv-${Date.now()}`;
      const spy = vi
        .spyOn(db.buckets, "checkByName")
        .mockResolvedValue(null as never);
      await bucketCors(fakeReq(name), fakeRes().res, () => {});

      spy.mockResolvedValue({ id: 1, corsConfig: corsConfig(ORIGIN) } as never);
      await invalidate(name);
      const { res, headers } = fakeRes();
      await bucketCors(fakeReq(name), res, () => {});
      expect(headers["access-control-allow-origin"]).toBe(ORIGIN);
    });
  });

  describe("a failed lookup", () => {
    it("is not cached as no CORS config", async () => {
      const name = `err-cors-${Date.now()}`;
      vi.spyOn(db.buckets, "checkByName")
        .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
        .mockResolvedValue({ id: 1, corsConfig: corsConfig(ORIGIN) } as never);

      await bucketCors(fakeReq(name), fakeRes().res, () => {});
      const { res, headers } = fakeRes();
      await bucketCors(fakeReq(name), res, () => {});
      expect(headers["access-control-allow-origin"]).toBe(ORIGIN);
    });

    it("fails open for that request only, not as no rate limit", async () => {
      const name = `err-rl-${Date.now()}`;
      vi.spyOn(db.buckets, "checkByName")
        .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
        .mockResolvedValue({
          id: randomBucketId(),
          rateLimitConfig: oneRequestLimit,
        } as never);

      const next = vi.fn();
      await bucketRateLimit(fakeReq(name), fakeRes().res, next);
      expect(next).toHaveBeenCalledWith();

      expect(await refusedOfThree(name)).toBe(2);
    });
  });
});
