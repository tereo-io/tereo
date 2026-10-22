import { HTTP_STATUS } from "./support/files.js";
import { CORE_URL } from "./support/coreUrl.js";
import { describe, it, expect } from "vitest";
import axios from "axios";

const BASE_URL = CORE_URL;

describe("Health Endpoint", () => {
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
      // caller gets the external tier, 300 a second.
      const get = (ip: string) =>
        axios.get(`${BASE_URL}/health`, {
          headers: { "X-Forwarded-For": ip },
          validateStatus: () => true,
        });
      const statuses = (
        await Promise.all(
          Array.from({ length: 400 }, () => get("198.51.100.20"))
        )
      ).map((r) => r.status);
      expect(statuses).toContain(429);
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
});

describe("CORS preflight", () => {
  it("allows the custom headers the admin UI sends", async () => {
    const response = await axios.options(`${BASE_URL}/v1/files/buckets`, {
      headers: {
        Origin: "http://localhost:4000",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers":
          "idempotency-key,x-organization-id,x-tags",
      },
      validateStatus: () => true,
    });

    const allowed = String(response.headers["access-control-allow-headers"])
      .toLowerCase()
      .split(",")
      .map((h) => h.trim());
    expect(allowed).toEqual(
      expect.arrayContaining(["idempotency-key", "x-organization-id", "x-tags"])
    );
  });
});
