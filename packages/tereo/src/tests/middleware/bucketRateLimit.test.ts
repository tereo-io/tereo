// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
} from "../support/files.js";

describe("bucketRateLimit", () => {
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
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
