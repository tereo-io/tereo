import { HTTP_STATUS } from "./files/utils/test-helpers.js";
import { CORE_URL } from "./utils/coreUrl.js";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
      // Read from package.json, not npm_package_version, which only npm sets.
      const pkg = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8")
      ) as { version: string };
      expect(pkg.version).not.toBe("0.0.0");
      expect(data.version).toBe(pkg.version);
      expect(data.timestamp).toBeDefined();
      expect(typeof data.timestamp).toBe("string");
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
