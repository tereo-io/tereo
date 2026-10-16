import { getTestAccessToken as getWebhooksToken } from "./webhooks/utils/test-helpers.js";
import { getTestAccessToken as getAuditToken } from "./audit/utils/test-helpers.js";
import { provisionService } from "./provisioning/utils/test-helpers.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_URL } from "./utils/coreUrl.js";
import axios from "axios";
import {
  BASE_URL as FILES_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObjectAndGetId,
} from "./files/utils/test-helpers.js";

const ROOT = CORE_URL;

const get = (path: string, headers: Record<string, string> = {}) =>
  axios.get(`${ROOT}${path}`, { headers, validateStatus: () => true });

describe("URL layout", () => {
  it("serves core's own API under /v1", async () => {
    expect((await get("/v1/admin/users")).status).toBe(401);
    expect((await get("/v1/account/profile")).status).toBe(401);
    expect((await get("/v1/audit/entries")).status).toBe(401);
    expect((await get("/v1/webhooks/webhooks")).status).toBe(401);
    expect((await get("/v1/files/buckets")).status).toBe(401);
    expect((await get("/v1/setup/status")).status).toBe(200);
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
    const response = await get(path, { Accept: "application/json" });
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
      const response = await get(path, { Authorization: `Bearer ${token}` });
      expect(response.status, path).toBe(404);
    }
    expect(
      (
        await get("/v1/audit/entries", {
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
    const discovery = await get("/.well-known/openid-configuration");
    expect(discovery.status).toBe(200);
    expect(discovery.data.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(discovery.data.userinfo_endpoint).toMatch(/\/oauth\/userinfo$/);
    expect((await get("/health")).status).toBe(200);
  });
});

describe("generated file URLs", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("points presigned URLs under /v1/files", async () => {
    const bucket = await createTestBucket(token);
    const file = createTestFile("hello", "hello.txt", "text/plain");
    const id = await uploadTestObjectAndGetId(
      token,
      bucket.name,
      "hello.txt",
      file
    );
    const presign = await axios.post(
      `${FILES_URL}/buckets/${bucket.name}/objects/by-id/${id}/presign`,
      { operation: "read", expiresInSeconds: 60 },
      {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      }
    );
    expect(presign.status).toBe(200);
    expect(new URL(presign.data.url).pathname).toMatch(
      /^\/v1\/files\/signed\//
    );

    const download = await axios.get(presign.data.url, {
      responseType: "text",
      validateStatus: () => true,
    });
    expect(download.status).toBe(200);
    expect(download.data).toBe("hello");
  });
});
