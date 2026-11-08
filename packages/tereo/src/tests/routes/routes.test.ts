// @module-tag int
// @module-tag platform
import { getTestAccessToken as getWebhooksToken } from "../support/webhooks.js";
import { getTestAccessToken as getAuditToken } from "../support/audit.js";
import { invalidateBranding } from "../../utils/branding/resolve.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { LOGIN_CLIENT } from "../../definitions/loginClient.js";
import { provisionService } from "../support/provisioning.js";
import { generateUniqueId } from "../support/auth/crypto.js";
import { createTestUser } from "../support/auth/users.js";
import { RESERVED_PREFIXES } from "../../utils/ui.js";
import { prisma } from "../../utils/db/prisma.js";
import { HTTP_STATUS } from "../support/files.js";
import { CORE_URL } from "../support/coreUrl.js";
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

    // The general limiter sets X-RateLimit-Limit on a request it lets through.
    it("rate-limits the branded sign-in pages and nothing else of the UI", async () => {
      for (const path of [
        "/login",
        "/login/2fa",
        "/consent",
        "/set-password",
      ]) {
        const response = await get(`${path}?client_id=x`);
        expect(response.status, path).toBe(HTTP_STATUS.OK);
        expect(response.headers["x-ratelimit-limit"], path).toBeDefined();
      }
      for (const path of ["/", "/auth-admin/users/123", "/favicon.ico"]) {
        const response = await get(path);
        expect(response.headers["x-ratelimit-limit"], path).toBeUndefined();
      }
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

describe("branding in the app shell", () => {
  let clientUuid: string;
  let clientId: string;
  let unbrandedUuid: string;
  let unbrandedId: string;
  let hadDefault = false;
  let ownedDefaultId: string | null = null;

  const BLOCK =
    /<script type="application\/json" id="tereo-branding">([\s\S]*?)<\/script>/;

  const block = (html: string): unknown => {
    const match = BLOCK.exec(html);
    return match ? JSON.parse(match[1]) : undefined;
  };

  // The server learns of a write through Redis, a moment after the publish.
  const getUntil = async (path: string, done: (html: string) => boolean) => {
    let response = await get(path);
    for (let i = 0; i < 40 && !done(response.data); i++) {
      await new Promise((r) => setTimeout(r, 50));
      response = await get(path);
    }
    return response;
  };

  const makeClient = async (name: string) => {
    const owner = await createTestUser();
    const id = `branding-shell-${generateUniqueId()}`;
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: id,
        name,
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        ownerId: owner.id,
      },
    });
    return { id, uuid: client.id };
  };

  beforeAll(async () => {
    hadDefault = !!(await prisma.brandingProfile.findFirst({
      where: { clientId: null },
    }));
    ({ id: clientId, uuid: clientUuid } = await makeClient("Branded"));
    ({ id: unbrandedId, uuid: unbrandedUuid } = await makeClient("Plain"));
    await prisma.brandingProfile.create({
      data: {
        clientId: clientUuid,
        appName: "Acme",
        colorsLight: { "--k-primary-color": "#00bb55" },
        updatedBy: SYSTEM_USER_ID,
      },
    });
    await invalidateBranding();
  });

  afterAll(async () => {
    // Each client's profile goes with it (cascade).
    await prisma.oAuthClient.deleteMany({
      where: { id: { in: [clientUuid, unbrandedUuid] } },
    });
    if (ownedDefaultId) {
      await prisma.brandingProfile.deleteMany({
        where: { id: ownedDefaultId },
      });
    }
    await invalidateBranding();
  });

  it("injects a client's branding into /login", async () => {
    const response = await getUntil(`/login?client_id=${clientId}`, (html) =>
      html.includes("<title>Acme</title>")
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.data).toContain('id="tereo-branding"');
    expect(response.data).toContain("--k-primary-color:#00bb55");
    expect(response.data).toContain("<title>Acme</title>");
    expect(block(response.data)).toMatchObject({
      scope: "auth",
      appName: "Acme",
    });
  });

  it("brands /login/* for the client", async () => {
    const response = await get(`/login/2fa?client_id=${clientId}`);

    expect(response.data).toContain("<title>Acme</title>");
    expect(block(response.data)).toMatchObject({ appName: "Acme" });
  });

  it("writes a null block for an unbranded client with no default", async (ctx) => {
    if (hadDefault) ctx.skip();
    const response = await get(`/login?client_id=${unbrandedId}`);

    expect(response.data).toContain('id="tereo-branding"');
    expect(block(response.data)).toBeNull();
    expect(response.data).toContain(SHELL);
    expect(response.data).not.toContain("<style");
  });

  describe("with a default profile", () => {
    let defaultBlock: unknown;

    beforeAll(async () => {
      if (!hadDefault) {
        const row = await prisma.brandingProfile.create({
          data: {
            clientId: null,
            appName: "Default Co",
            updatedBy: SYSTEM_USER_ID,
          },
        });
        ownedDefaultId = row.id;
        await invalidateBranding();
      }
      const response = await getUntil(
        "/login",
        (html) => hadDefault || html.includes("<title>Default Co</title>")
      );
      defaultBlock = block(response.data);
      if (!hadDefault) {
        expect(defaultBlock).toMatchObject({ appName: "Default Co" });
      }
    });

    it.each([
      ["an array", "?client_id[]=a&client_id[]=b"],
      ["an empty string", "?client_id="],
      ["10 000 characters", `?client_id=${"x".repeat(10_000)}`],
    ])("gives a client_id that is %s the default's branding", async (_, qs) => {
      const response = await get(`/login${qs}`);

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(block(response.data)).toEqual(defaultBlock);
    });

    it("gives an unbranded client the default's branding", async () => {
      const response = await get(`/login?client_id=${unbrandedId}`);

      expect(block(response.data)).toEqual(defaultBlock);
    });

    it("gives /set-password the default's branding", async () => {
      const response = await get("/set-password");

      expect(block(response.data)).toEqual(defaultBlock);
    });
  });

  it("brands the console only once the tereo-ui profile applies to it", async (ctx) => {
    const consoleClient = await prisma.oAuthClient.findUnique({
      where: { clientId: LOGIN_CLIENT.clientId },
      select: { id: true },
    });
    const existing =
      consoleClient &&
      (await prisma.brandingProfile.findFirst({
        where: { clientId: consoleClient.id },
      }));
    if (!consoleClient || existing) ctx.skip();

    const profile = await prisma.brandingProfile.create({
      data: {
        clientId: consoleClient!.id,
        appName: "Console Co",
        colorsLight: { "--k-primary-color": "#123456" },
        updatedBy: SYSTEM_USER_ID,
      },
    });
    try {
      await invalidateBranding();
      // Proves the server saw the profile before the console check below.
      await getUntil(`/login?client_id=${LOGIN_CLIENT.clientId}`, (html) =>
        html.includes("<title>Console Co</title>")
      );
      const before = await get("/auth-admin/users");
      expect(before.data).not.toContain('id="tereo-branding"');
      expect(before.data).toContain(SHELL);

      await prisma.brandingProfile.update({
        where: { id: profile.id },
        data: {
          applyToConsole: true,
          logoObjectId: null,
          headline: "Not for the console",
        },
      });
      await invalidateBranding();
      const after = await getUntil("/auth-admin/users", (html) =>
        html.includes('id="tereo-branding"')
      );
      expect(block(after.data)).toEqual({
        scope: "console",
        appName: "Console Co",
        colorsLight: { "--k-primary-color": "#123456" },
        colorsDark: {},
      });
      expect(after.data).not.toContain("logoUrl");
      expect(after.data).toContain("<title>Console Co</title>");
      expect(after.data).toContain("--k-primary-color:#123456");
    } finally {
      await prisma.brandingProfile.deleteMany({ where: { id: profile.id } });
      await invalidateBranding();
      await getUntil(
        "/auth-admin/users",
        (html) => !html.includes('id="tereo-branding"')
      );
    }
  });
});
