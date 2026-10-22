import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
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

const FIRST = "https://first.bucket-cors.test";
const SECOND = "https://second.bucket-cors.test";

describe("per-bucket CORS", () => {
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

  it.each([
    { allowedOrigins: ["https://ok.test\r\nX-Injected: 1"] },
    { allowedOrigins: ["https://ok.test/path"] },
    { allowedOrigins: ["https://bücher.test"] },
    { allowedOrigins: [FIRST], allowedHeaders: ["X-Ok\r\nX-Injected: 1"] },
    { allowedOrigins: [FIRST], exposedHeaders: ["X-Тест"] },
  ])("refuses a config that can't be a header value: %j", async (cfg) => {
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucketName}`,
      { corsConfig: cfg },
      {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      }
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it("accepts origins with ports, IPv6 hosts and the wildcard", async () => {
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucketName}`,
      {
        corsConfig: {
          allowedOrigins: ["http://localhost:3000", "http://[::1]:8080", "*"],
          allowedHeaders: ["X-Custom-Header", "*"],
        },
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
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
