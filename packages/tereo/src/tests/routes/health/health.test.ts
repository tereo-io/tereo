// @module-tag int
// @module-tag platform
import { spendRateLimit } from "../../support/redis.js";
import { HTTP_STATUS } from "../../support/files.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { describe, it, expect } from "vitest";
import env from "../../../env.js";
import axios from "axios";

const BASE_URL = CORE_URL;

describe("GET /health/ready", () => {
  it("is ok while the server is up", async () => {
    const response = await axios.get(`${BASE_URL}/health/ready`, {
      validateStatus: () => true,
    });

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.data).toMatchObject({ status: "ok", service: "tereo" });
  });
});

describe("GET /health", () => {
  it("should return 200 with service status", async () => {
    const response = await axios.get(`${BASE_URL}/health`, {
      validateStatus: () => true,
    });

    expect(response.status).toBe(HTTP_STATUS.OK);

    const data = response.data;
    expect(data.status).toBe("ok");
    expect(data.service).toBe("tereo");
    expect(data.timestamp).toBeDefined();
    expect(typeof data.timestamp).toBe("string");
  });

  it("names no version", async () => {
    const response = await axios.get(`${BASE_URL}/health`, {
      validateStatus: () => true,
    });
    expect(response.data).not.toHaveProperty("version");
  });

  it("is rate-limited per address", async () => {
    // The default TRUST_PROXY (loopback) honours X-Forwarded-For; a proxied
    // caller gets the external tier.
    const limit = env.RATE_LIMIT_PRE_AUTH_PER_SECOND;
    const get = (ip: string) =>
      axios.get(`${BASE_URL}/health`, {
        headers: { "X-Forwarded-For": ip },
        validateStatus: () => true,
      });
    await spendRateLimit("health", "198.51.100.20", limit, 5);
    const statuses = (
      await Promise.all(Array.from({ length: 10 }, () => get("198.51.100.20")))
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);

    const limited = await get("198.51.100.20");
    expect(limited.status).toBe(429);
    expect(limited.data).toMatchObject({ error: "too_many_requests" });
    expect(limited.data.retry_after).toBeGreaterThan(0);
    expect(limited.headers["retry-after"]).toBe(
      String(limited.data.retry_after)
    );
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(limit));
    expect((await get("198.51.100.21")).status).toBe(HTTP_STATUS.OK);
  });

  it("should not require authentication", async () => {
    // Health endpoint should be accessible without auth
    const response = await axios.get(`${BASE_URL}/health`, {
      validateStatus: () => true,
    });

    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  it("should return valid ISO timestamp", async () => {
    const response = await axios.get(`${BASE_URL}/health`, {
      validateStatus: () => true,
    });

    const data = response.data;

    // Verify timestamp is valid ISO 8601 format
    const timestamp = new Date(data.timestamp);
    expect(timestamp.toISOString()).toBe(data.timestamp);
  });
});
