// @module-tag int
// @module-tag auth
// @module-tag security
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { makeServiceOf } from "../../support/testService.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
  createTestClient,
  createTestUser,
  type TokenResponse,
} from "../../support/auth.js";

describe("client authentication at /oauth", () => {
  /**
   * A deactivated service's or integration's secret authenticates nowhere:
   * not at /oauth/token, and not at /oauth/introspect, /oauth/check-permission
   * or /oauth/revoke either.
   */

  type Client = Awaited<ReturnType<typeof createTestClient>>;

  const basic = (client: Client) =>
    `Basic ${Buffer.from(`${client.clientId}:${client.plainSecret}`).toString(
      "base64"
    )}`;

  const post = (client: Client, path: string, body: Record<string, unknown>) =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic(client),
      },
      body: JSON.stringify(body),
    });

  const serviceToken = async (client: Client): Promise<string> => {
    const res = await post(client, "/oauth/token", {
      grant_type: "client_credentials",
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    return ((await res.json()) as TokenResponse).access_token!;
  };

  const expectInvalidClient = async (res: Response) => {
    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(((await res.json()) as { error: string }).error).toBe(
      OAUTH_ERRORS.INVALID_CLIENT
    );
  };

  describe.each([
    ["service and account deactivated", { service: false, account: false }],
    ["service deactivated", { service: false, account: true }],
    ["account deactivated", { service: true, account: false }],
  ])("a client whose %s", (_label, active) => {
    let client: Client;
    let token: string;
    let userId: string;

    beforeEach(async () => {
      client = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
        scopes: [],
      });
      await makeServiceOf(client.id);
      token = await serviceToken(client);
      userId = (await createTestUser()).id;

      // Before deactivation, every endpoint accepts the secret.
      expect((await post(client, "/oauth/introspect", { token })).status).toBe(
        HTTP_STATUS.OK
      );

      await prisma.service.update({
        where: { clientId: client.id },
        data: { isActive: active.service },
      });
      await prisma.user.update({
        where: { oauthClientId: client.id },
        data: { isActive: active.account },
      });
    });

    it("is refused at /oauth/introspect", async () => {
      await expectInvalidClient(
        await post(client, "/oauth/introspect", { token })
      );
    });

    it("is refused at /oauth/check-permission", async () => {
      await expectInvalidClient(
        await post(client, "/oauth/check-permission", {
          user_id: userId,
          permission: "webhooks.read",
        })
      );
      await expectInvalidClient(
        await post(client, "/oauth/check-permission/batch", {
          user_id: userId,
          permissions: ["webhooks.read"],
        })
      );
    });

    it("is refused at /oauth/revoke", async () => {
      await expectInvalidClient(await post(client, "/oauth/revoke", { token }));
    });
  });
});

describe("client authentication at /oauth", () => {
  const REDIRECT_URI = "http://localhost:3000/callback";

  type Client = Awaited<ReturnType<typeof createTestClient>>;

  const basic = (client: Client) =>
    `Basic ${Buffer.from(`${client.clientId}:${client.plainSecret}`).toString("base64")}`;

  const json = async (res: Response) =>
    (await res.json()) as Record<string, unknown>;

  const form = (body: Record<string, string>) =>
    new URLSearchParams(body).toString();

  const postForm = (
    path: string,
    body: Record<string, string>,
    headers: Record<string, string> = {}
  ) =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: form(body),
    });

  let publicClient: Client;
  let ccClient: Client;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
    ccClient = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    user = await createTestUser();
  });

  describe("Client authentication", () => {
    it("answers a failed Basic authentication with a Basic challenge", async () => {
      const res = await postForm(
        "/oauth/token",
        { grant_type: "client_credentials" },
        {
          Authorization: `Basic ${Buffer.from(`${ccClient.clientId}:wrong`).toString("base64")}`,
        }
      );
      expect(res.status).toBe(401);
      expect((await json(res)).error).toBe("invalid_client");
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);
    });

    it("challenges on introspect, revoke and check-permission too", async () => {
      const wrong = {
        Authorization: `Basic ${Buffer.from(`${ccClient.clientId}:wrong`).toString("base64")}`,
      };
      for (const path of ["/oauth/introspect", "/oauth/revoke"]) {
        const res = await postForm(path, { token: "x" }, wrong);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);
      }
      const res = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: user.id, permission: "users.read" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);
    });

    it("refuses a body client_id that differs from the Basic one", async () => {
      const res = await postForm(
        "/oauth/token",
        { grant_type: "client_credentials", client_id: publicClient.clientId },
        { Authorization: basic(ccClient) }
      );
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_request");
    });

    it("accepts form-urlencoded Basic credentials", async () => {
      const encoded = `${encodeURIComponent(ccClient.clientId)}:${encodeURIComponent(ccClient.plainSecret!)}`;
      const res = await postForm(
        "/oauth/token",
        { grant_type: "client_credentials" },
        { Authorization: `Basic ${Buffer.from(encoded).toString("base64")}` }
      );
      expect(res.status).toBe(200);
    });

    it("mints nothing for a client whose service account is inactive", async () => {
      const client = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      await prisma.user.update({
        where: { oauthClientId: client.id },
        data: { isActive: false },
      });
      const res = await postForm(
        "/oauth/token",
        { grant_type: "client_credentials" },
        { Authorization: basic(client) }
      );
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("unauthorized_client");
    });
  });
});
