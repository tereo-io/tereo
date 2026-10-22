// @module-tag int
// @module-tag platform
import { getTestAccessToken as getWebhooksToken } from "../support/webhooks.js";
import { getTestAccessToken as getAuditToken } from "../support/audit.js";
import { provisionService } from "../support/provisioning.js";
import { RESERVED_PREFIXES } from "../../utils/ui.js";
import { HTTP_STATUS } from "../support/files.js";
import { CORE_URL } from "../support/coreUrl.js";
import { describe, expect, it } from "vitest";
import axios from "axios";

// The suite's server serves tests/fixtures/ui-dist (UI_DIST_PATH in testEnv).
const BASE_URL = CORE_URL;

const HTML = { Accept: "text/html,application/xhtml+xml" };

const SHELL = "Tereo UI fixture";

const request = (
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string> = HTML
) =>
  axios.request({
    method,
    url: `${BASE_URL}${path}`,
    headers,
    maxRedirects: 0,
    validateStatus: () => true,
    responseType: "text",
  });

const get = (path: string, headers?: Record<string, string>) =>
  request("GET", path, headers);

describe("root router", () => {
  describe("URL layout", () => {
    const ROOT = CORE_URL;

    const getCore = (path: string, headers: Record<string, string> = {}) =>
      axios.get(`${ROOT}${path}`, { headers, validateStatus: () => true });

    it("serves core's own API under /v1", async () => {
      expect((await getCore("/v1/admin/users")).status).toBe(401);
      expect((await getCore("/v1/account/profile")).status).toBe(401);
      expect((await getCore("/v1/audit/entries")).status).toBe(401);
      expect((await getCore("/v1/webhooks/webhooks")).status).toBe(401);
      expect((await getCore("/v1/files/buckets")).status).toBe(401);
      expect((await getCore("/v1/setup/status")).status).toBe(200);
    });

    it.each([
      "/admin/users",
      "/account/profile",
      "/files/buckets",
      "/audit/v1/entries",
      "/webhooks/v1/webhooks",
      "/registry/declaration",
      "/setup/status",
    ])("answers the old path %s with a JSON 404", async (path) => {
      const response = await getCore(path, { Accept: "application/json" });
      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toMatch(/json/);
    });

    // Audit and webhooks authenticate before routing, so the nested path needs a
    // token to reach the 404.
    it("drops the per-area /v1 of audit and webhooks", async () => {
      const auditToken = await getAuditToken();
      const webhooksToken = await getWebhooksToken();
      for (const [path, token] of [
        ["/v1/audit/v1/entries", auditToken],
        ["/v1/webhooks/v1/webhooks", webhooksToken],
      ]) {
        const response = await getCore(path, {
          Authorization: `Bearer ${token}`,
        });
        expect(response.status, path).toBe(404);
      }
      expect(
        (
          await getCore("/v1/audit/entries", {
            Authorization: `Bearer ${auditToken}`,
          })
        ).status
      ).toBe(200);
    });

    it("has no registration route: services are provisioned", async () => {
      const { credentials } = await provisionService();
      const tokenResponse = await fetch(`${ROOT}/oauth/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      expect(tokenResponse.status).toBe(200);
      const { access_token } = (await tokenResponse.json()) as {
        access_token: string;
      };
      const response = await axios.post(
        `${ROOT}/v1/registry/declaration`,
        { version: "1.0.0" },
        {
          headers: { Authorization: `Bearer ${access_token}` },
          validateStatus: () => true,
        }
      );
      expect(response.status).toBe(404);
    });

    it("keeps the protocol and infrastructure paths at the root", async () => {
      const discovery = await getCore("/.well-known/openid-configuration");
      expect(discovery.status).toBe(200);
      expect(discovery.data.token_endpoint).toMatch(/\/oauth\/token$/);
      expect(discovery.data.userinfo_endpoint).toMatch(/\/oauth\/userinfo$/);
      expect((await getCore("/health")).status).toBe(200);
    });
  });

  describe("Admin UI at /", () => {
    it("serves index.html at /, uncached", async () => {
      const response = await get("/");

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers["content-type"]).toMatch(/text\/html/);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.data).toContain(SHELL);
    });

    it.each(["/auth-admin/users/123", "/shared/abc123/report.pdf", "/setup"])(
      "answers the client-side route %s with the app shell",
      async (path) => {
        const response = await get(path);

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data).toContain(SHELL);
      }
    );

    it("caches hashed assets for a year", async () => {
      const response = await get("/assets/index-fixture.js", {});

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers["cache-control"]).toContain("immutable");
    });

    it("revalidates unhashed files", async () => {
      const response = await get("/favicon.ico", {});

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers["cache-control"]).toBe("no-cache");
    });

    it("404s a missing asset rather than serving HTML", async () => {
      const response = await get("/assets/missing.js", {});

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(response.headers["content-type"]).not.toMatch(/html/);
    });

    it.each(RESERVED_PREFIXES)(
      "never answers %s/nope with the app shell",
      async (prefix) => {
        const response = await get(`${prefix}/nope`);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers["content-type"]).not.toMatch(/html/);
      }
    );

    it.each(["/assets", "/V1/nope", "/OAuth/nope"])(
      "answers %s with a JSON 404",
      async (path) => {
        const response = await get(path);

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
        expect(response.headers["content-type"]).toMatch(/json/);
      }
    );

    it("answers a JSON request to / with a JSON 404", async () => {
      const response = await get("/", { Accept: "application/json" });

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(response.headers["content-type"]).toMatch(/json/);
    });

    it("answers a POST to a UI path with a JSON 404", async () => {
      const response = await request("POST", "/auth-admin");

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(response.headers["content-type"]).toMatch(/json/);
    });

    it("keeps no alias at /ui", async () => {
      const response = await get("/ui/", { Accept: "application/json" });

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("leaves the API routes to the API", async () => {
      const response = await get("/v1/account", {});

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
    });
  });
});
