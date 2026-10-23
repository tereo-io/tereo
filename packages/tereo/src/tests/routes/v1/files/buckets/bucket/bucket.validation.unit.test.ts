// @module-tag unit
// @module-tag files
import { updateBucketSchema } from "../../../../../../routes/v1/files/buckets/bucket/schemas.js";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://first.bucket-cors.test";

describe("PUT /v1/files/buckets/:name", () => {
  describe("updateBucketSchema", () => {
    it.each([
      { allowedOrigins: ["https://ok.test\r\nX-Injected: 1"] },
      { allowedOrigins: ["https://ok.test/path"] },
      { allowedOrigins: ["https://bücher.test"] },
      { allowedOrigins: [ORIGIN], allowedHeaders: ["X-Ok\r\nX-Injected: 1"] },
      { allowedOrigins: [ORIGIN], exposedHeaders: ["X-Тест"] },
    ])("rejects a CORS config that can't be a header value: %j", (cfg) => {
      expect(updateBucketSchema.safeParse({ corsConfig: cfg }).success).toBe(
        false
      );
    });

    it("accepts CORS origins with ports, IPv6 hosts and the wildcard", () => {
      const result = updateBucketSchema.safeParse({
        corsConfig: {
          allowedOrigins: ["http://localhost:3000", "http://[::1]:8080", "*"],
          allowedHeaders: ["X-Custom-Header", "*"],
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects a rate limit whose requestCost exceeds maxTokens", () => {
      const result = updateBucketSchema.safeParse({
        rateLimitConfig: { tokensPerSecond: 1, maxTokens: 2, requestCost: 3 },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual([
        "rateLimitConfig",
        "requestCost",
      ]);
    });

    it("accepts a rate limit whose requestCost equals maxTokens", () => {
      const result = updateBucketSchema.safeParse({
        rateLimitConfig: { tokensPerSecond: 1, maxTokens: 2, requestCost: 2 },
      });
      expect(result.success).toBe(true);
    });
  });
});
