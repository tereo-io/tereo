// @module-tag int
// @module-tag files
import { bucketRateLimit } from "../../middleware/bucketRateLimit.js";
import db from "../../utils/db/index.js";
import axios from "axios";
import {
  closeCacheBroadcast,
  startCacheSubscriber,
} from "../../utils/cacheBroadcast.js";
import {
  deferred,
  fakeReq,
  fakeRes,
  invalidate,
} from "../support/bucketCache.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
} from "../support/files.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

describe("bucketRateLimit", () => {
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
    await startCacheSubscriber();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeCacheBroadcast();
    await cleanupTestEntities();
  });

  describe(
    "a lookup that read the bucket before an invalidation",
    { tags: ["race"] },
    () => {
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
    }
  );

  describe("a failed lookup", () => {
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

  describe("PUT /buckets/:name", () => {
    it("answers the per-bucket rate limit like the general limiter", async () => {
      const bucket = await createTestBucket(testToken);
      const headers = { Authorization: `Bearer ${testToken}` };
      const set = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { rateLimitConfig: { tokensPerSecond: 0.01, maxTokens: 1 } },
        { headers, validateStatus: () => true }
      );
      expect(set.status).toBe(HTTP_STATUS.OK);

      const list = () =>
        axios.get(`${BASE_URL}/buckets/${bucket.name}/objects`, {
          headers,
          validateStatus: () => true,
        });
      expect((await list()).status).toBe(HTTP_STATUS.OK);

      const limited = await list();
      expect(limited.status).toBe(429);
      expect(limited.data).toMatchObject({
        error: "too_many_requests",
        retry_after: expect.any(Number),
      });
      expect(limited.data.retry_after).toBeGreaterThanOrEqual(1);
      expect(limited.headers["retry-after"]).toBe(
        String(limited.data.retry_after)
      );
      expect(limited.headers["x-ratelimit-limit"]).toBe("1");
      expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
      expect(
        Date.parse(limited.headers["x-ratelimit-reset"] as string)
      ).toBeGreaterThan(Date.now());
    });

    it("counts anonymous callers of the per-bucket limit per address", async () => {
      const bucket = await createTestBucket(testToken, { policy: "public" });
      const set = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { rateLimitConfig: { tokensPerSecond: 0.01, maxTokens: 1 } },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(set.status).toBe(HTTP_STATUS.OK);

      // The default TRUST_PROXY (loopback) honours X-Forwarded-For.
      const list = (ip: string) =>
        axios.get(`${BASE_URL}/buckets/${bucket.name}/objects`, {
          headers: { "X-Forwarded-For": ip },
          validateStatus: () => true,
        });
      expect((await list("203.0.113.10")).status).toBe(HTTP_STATUS.OK);
      expect((await list("203.0.113.10")).status).toBe(429);
      expect((await list("203.0.113.11")).status).toBe(HTTP_STATUS.OK);
    });
  });
});
