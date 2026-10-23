// @module-tag int
// @module-tag files
import { bucketCors } from "../../middleware/bucketCors.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  closeCacheBroadcast,
  startCacheSubscriber,
} from "../../utils/cacheBroadcast.js";
import {
  ORIGIN,
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
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
  waitFor,
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

const corsConfig = (origin: string) => ({
  allowedOrigins: [origin],
  allowedMethods: ["GET"],
  allowedHeaders: [],
  maxAgeSeconds: 60,
  allowCredentials: false,
});

describe("bucketCors", () => {
  beforeAll(async () => {
    await startCacheSubscriber();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeCacheBroadcast();
  });

  describe(
    "a lookup that read the bucket before an invalidation",
    { tags: ["race"] },
    () => {
      it("does not cache the old CORS config", async () => {
        const name = `race-cors-${Date.now()}`;
        const oldRead = deferred<unknown>();
        const spy = vi
          .spyOn(db.buckets, "checkByName")
          .mockImplementationOnce(() => oldRead.promise as never);

        const pending = bucketCors(fakeReq(name), fakeRes().res, () => {});
        await invalidate(name);
        oldRead.resolve({
          id: 1,
          corsConfig: corsConfig("https://old.example"),
        });
        await pending;

        spy.mockImplementation(
          async () => ({ id: 1, corsConfig: corsConfig(ORIGIN) }) as never
        );
        const { res, headers } = fakeRes();
        await bucketCors(fakeReq(name), res, () => {});
        expect(headers["access-control-allow-origin"]).toBe(ORIGIN);
      });
    }
  );

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
  });
});

describe("bucketCors", () => {
  const FIRST = "https://first.bucket-cors.test";
  const SECOND = "https://second.bucket-cors.test";
  let token: string;
  let bucketName: string;

  const setCors = async (origin: string) => {
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucketName}`,
      {
        corsConfig: {
          allowedOrigins: [origin],
          allowedMethods: ["GET", "PUT"],
          allowedHeaders: ["Content-Type", "Authorization"],
          exposedHeaders: ["ETag"],
          maxAgeSeconds: 120,
          allowCredentials: false,
        },
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
  };

  const preflight = (origin: string) =>
    axios.options(`${BASE_URL}/buckets/${bucketName}/objects/a.txt`, {
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "Authorization",
      },
      validateStatus: () => true,
    });

  beforeAll(async () => {
    token = await getTestAccessToken();
    const bucket = await createTestBucket(token);
    bucketName = bucket.name;
    await uploadTestObject(
      token,
      bucketName,
      "a.txt",
      createTestFile(`cors ${randomUUID()}`)
    );
    await setCors(FIRST);
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("answers a preflight from the bucket's config", async () => {
    const res = await preflight(FIRST);
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(res.headers["access-control-allow-origin"]).toBe(FIRST);
    expect(res.headers["access-control-allow-methods"]).toBe("GET, PUT");
    expect(res.headers["access-control-allow-headers"]).toBe(
      "Content-Type, Authorization"
    );
    expect(res.headers["access-control-max-age"]).toBe("120");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("sets the headers on an actual request", async () => {
    const res = await axios.get(
      `${BASE_URL}/buckets/${bucketName}/objects/a.txt`,
      {
        headers: { Authorization: `Bearer ${token}`, Origin: FIRST },
        validateStatus: () => true,
      }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.headers["access-control-allow-origin"]).toBe(FIRST);
    expect(res.headers["access-control-expose-headers"]).toBe("ETag");
    expect(res.headers.vary).toMatch(/Origin/);
  });

  it("allows no credentials from any origin under a wildcard config without them", async () => {
    // The global cors() allows credentials on every response it touches.
    const bucket = await createTestBucket(token);
    const put = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      {
        corsConfig: {
          allowedOrigins: ["*"],
          allowedMethods: ["GET"],
          allowedHeaders: ["Authorization"],
          maxAgeSeconds: 60,
          allowCredentials: false,
        },
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      }
    );
    expect(put.status).toBe(HTTP_STATUS.OK);
    await uploadTestObject(token, bucket.name, "a.txt", createTestFile("x"));
    const res = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/objects/a.txt`,
      {
        headers: { Authorization: `Bearer ${token}`, Origin: SECOND },
        validateStatus: () => true,
      }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.headers["access-control-allow-origin"]).toBe(SECOND);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("drops a header value stored before validation instead of failing", async () => {
    const bucket = await createTestBucket(token);
    // As a config saved before the schema checked header names would be.
    await prisma.bucket.update({
      where: { id: bucket.id },
      data: {
        corsConfig: {
          allowedOrigins: [FIRST],
          allowedMethods: ["GET"],
          allowedHeaders: ["Authorization", "X-Bad\r\nSet-Cookie: x=1"],
          exposedHeaders: ["ETag", "Bad Header"],
          maxAgeSeconds: 60,
          allowCredentials: false,
        },
      },
    });
    const res = await axios.options(
      `${BASE_URL}/buckets/${bucket.name}/objects/a.txt`,
      {
        headers: { Origin: FIRST, "Access-Control-Request-Method": "GET" },
        validateStatus: () => true,
      }
    );
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(res.headers["access-control-allow-headers"]).toBe("Authorization");
    expect(res.headers["access-control-expose-headers"]).toBe("ETag");
  });

  it("gives no allowance to an origin the config doesn't list", async () => {
    const res = await preflight(SECOND);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("takes a config change at once, through the invalidation broadcast", async () => {
    // Both origins are now cached; only the broadcast can move them inside
    // the cache's minute.
    await setCors(SECOND);
    await waitFor(
      async () =>
        (await preflight(SECOND)).headers["access-control-allow-origin"] ===
        SECOND,
      5_000
    );
    expect(
      (await preflight(FIRST)).headers["access-control-allow-origin"]
    ).toBeUndefined();
  });

  it("limits bucket preflights per address", async () => {
    // The default TRUST_PROXY (loopback) honours X-Forwarded-For; a proxied
    // caller gets the external tier, 300 a second.
    const send = (ip: string) =>
      axios.options(
        `${BASE_URL}/buckets/missing-${randomUUID()}/objects/a.txt`,
        {
          headers: {
            Origin: FIRST,
            "Access-Control-Request-Method": "PUT",
            "X-Forwarded-For": ip,
          },
          validateStatus: () => true,
        }
      );
    const statuses = (
      await Promise.all(Array.from({ length: 400 }, () => send("198.51.100.7")))
    ).map((r) => r.status);
    expect(statuses).toContain(429);
    expect((await send("198.51.100.8")).status).not.toBe(429);
  });
});
