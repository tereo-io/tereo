// @module-tag int
// @module-tag auth
// @module-tag security

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { type TokenResponse } from "../support/auth/tokens.js";
import { createTestClient } from "../support/auth/clients.js";
import { makeServiceOf } from "../support/testService.js";
import { createTestUser } from "../support/auth/users.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
} from "../support/auth/constants.js";

const TOO_MANY_REQUESTS = 429;

let lastIp = 150;
/** A client address no earlier attempt in this file used. */
const freshIp = () => `203.0.113.${++lastIp}`;

const expectTooMany = async (res: Response) => {
  expect(res.status).toBe(TOO_MANY_REQUESTS);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(0);
  const body = (await res.json()) as { error: string; retry_after: number };
  expect(body.error).toBe("too_many_requests");
  expect(body.retry_after).toBe(retryAfter);
  return retryAfter;
};

describe("verifyClientSecretLimited", () => {
  const CLIENT_SECRET_FAILURES = 10;

  const basic = (clientId: string, secret: string) =>
    `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;

  const clientCredentials = (clientId: string, secret: string, ip: string) =>
    fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic(clientId, secret),
        "X-Forwarded-For": ip,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

  const introspect = (clientId: string, secret: string, ip: string) =>
    fetch(`${BASE_URL}/oauth/introspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic(clientId, secret),
        "X-Forwarded-For": ip,
      },
      body: new URLSearchParams({ token: "not-a-token" }),
    });

  it("refuses a client and IP after repeated wrong secrets, even with the right one", async () => {
    const confidential = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    const ip = freshIp();

    for (let i = 0; i < CLIENT_SECRET_FAILURES; i++) {
      const res = await clientCredentials(
        confidential.clientId,
        "wrong-secret",
        ip
      );
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    }

    // The right secret is refused before it is checked.
    await expectTooMany(
      await clientCredentials(
        confidential.clientId,
        confidential.plainSecret!,
        ip
      )
    );
    // The same counter guards the other client-authenticated endpoints.
    await expectTooMany(
      await introspect(confidential.clientId, confidential.plainSecret!, ip)
    );

    // Another address is not locked out of the client.
    const other = await clientCredentials(
      confidential.clientId,
      confidential.plainSecret!,
      freshIp()
    );
    expect(other.status).toBe(HTTP_STATUS.OK);
  });

  it(
    "lets any number of concurrent correct secrets from one address through",
    { tags: ["race"] },
    async () => {
      const confidential = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      const ip = freshIp();

      const results = await Promise.all(
        Array.from({ length: CLIENT_SECRET_FAILURES + 5 }, () =>
          introspect(confidential.clientId, confidential.plainSecret!, ip)
        )
      );
      expect(results.map((r) => r.status)).toEqual(
        results.map(() => HTTP_STATUS.OK)
      );
    }
  );

  it("clears the count on a successful authentication", async () => {
    const confidential = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    const ip = freshIp();

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < CLIENT_SECRET_FAILURES - 1; i++) {
        const res = await introspect(confidential.clientId, "wrong", ip);
        expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      }
      const ok = await clientCredentials(
        confidential.clientId,
        confidential.plainSecret!,
        ip
      );
      expect(ok.status).toBe(HTTP_STATUS.OK);
    }
  });
});

describe("authenticateClient", () => {
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

  const REDIRECT_URI = "http://localhost:3000/callback";

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

  /**
   * A deactivated service's or integration's secret authenticates nowhere:
   * not at /oauth/token, and not at /oauth/introspect, /oauth/check-permission
   * or /oauth/revoke either.
   */

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
