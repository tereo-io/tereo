import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { makeServiceOf } from "../utils/testService.js";
import { browserLogin } from "../utils/browserLogin.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  decodeJwt,
} from "./utils/test-helpers.js";

/**
 * Core's own API admits core's UI and services with the user's full rights;
 * any other client only with core API scopes, which put core in the token's
 * audience, and then no further than those scopes' ceilings.
 */

type Client = Awaited<ReturnType<typeof createTestClient>>;
type User = Awaited<ReturnType<typeof createTestUser>>;

const ALL_CORE_SCOPES = [
  "core:account",
  "core:admin",
  "core:admin.read",
  "core:files",
  "core:files.read",
  "core:audit",
  "core:audit.read",
  "core:webhooks",
  "core:webhooks.read",
];

const grantPermissions = (userId: string, permissions: string[]) =>
  getTestPrincipalToken({ userId, permissions });

const basic = (client: Client) =>
  `Basic ${Buffer.from(`${client.clientId}:${client.plainSecret}`).toString(
    "base64"
  )}`;

const introspect = async (client: Client, token: string) => {
  const res = await fetch(`${BASE_URL}/oauth/introspect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(client.plainSecret && { Authorization: basic(client) }),
    },
    body: new URLSearchParams({
      token,
      ...(!client.plainSecret && { client_id: client.clientId }),
    }),
  });
  return res;
};

/** A user access token from the browser login and code exchange. */
const loginToken = async (client: Client, user: User, scope: string) => {
  const redirectUri = client.redirectUris[0];
  const { code, verifier } = await browserLogin({
    clientId: client.clientId,
    redirectUri,
    scope,
    email: user.email,
    password: user.plainPassword,
  });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(client.plainSecret && { Authorization: basic(client) }),
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
    }),
  });
  expect(res.status).toBe(HTTP_STATUS.OK);
  return ((await res.json()) as { access_token: string }).access_token;
};

const call = (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

const userinfo = async (token: string) => {
  const res = await call(token, "/oauth/userinfo");
  expect(res.status).toBe(HTTP_STATUS.OK);
  return (await res.json()) as Record<string, unknown>;
};

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: string }).error;

let thirdParty: Client;

beforeAll(async () => {
  thirdParty = await createTestClient({
    scopes: ["openid", "profile", "email", ...ALL_CORE_SCOPES],
  });
});

describe("a third-party client's token without core scopes", () => {
  it("is refused with 401 invalid_token on /admin and /account", async () => {
    const user = await createTestUser();
    await grantPermissions(user.id, ["admin"]);
    const token = await loginToken(thirdParty, user, "openid profile email");
    expect(decodeJwt(token).aud).toBeUndefined();

    for (const path of [
      "/v1/admin/users",
      "/v1/account/me",
      "/v1/files/buckets",
    ]) {
      const res = await call(token, path);
      expect(res.status, path).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(await errorOf(res)).toBe("invalid_token");
      expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    }
  });

  it("still reaches /oauth/userinfo, without roles or permissions", async () => {
    const user = await createTestUser();
    await grantPermissions(user.id, ["users.read"]);
    const token = await loginToken(thirdParty, user, "openid email");
    const info = await userinfo(token);
    expect(info.sub).toBe(user.id);
    expect(info.email).toBe(user.email);
    expect(info).not.toHaveProperty("roles");
    expect(info).not.toHaveProperty("permissions");
  });
});

describe("roles and permissions at /oauth/userinfo", () => {
  const expectAuthorization = (info: Record<string, unknown>) => {
    expect(info.permissions).toContain("users.read");
    expect(Array.isArray(info.roles)).toBe(true);
    expect((info.roles as string[]).length).toBeGreaterThan(0);
  };

  it("are reported to core's UI", async () => {
    const user = await createTestUser();
    expectAuthorization(
      await userinfo(await grantPermissions(user.id, ["users.read"]))
    );
  });

  it("are reported to a service's client", async () => {
    const client = await createTestClient();
    await makeServiceOf(client.id);
    const user = await createTestUser();
    await grantPermissions(user.id, ["users.read"]);
    expectAuthorization(
      await userinfo(await loginToken(client, user, "openid"))
    );
  });

  it("are reported to a token carrying a core scope", async () => {
    const user = await createTestUser();
    await grantPermissions(user.id, ["users.read"]);
    expectAuthorization(
      await userinfo(await loginToken(thirdParty, user, "openid core:account"))
    );
  });
});

describe("core's UI token", () => {
  it("acts with the user's full rights, without any scope", async () => {
    const user = await createTestUser();
    const token = await grantPermissions(user.id, ["users.write"]);
    expect((await call(token, "/v1/admin/users")).status).toBe(HTTP_STATUS.OK);
    expect((await call(token, "/v1/account/me")).status).toBe(HTTP_STATUS.OK);
  });

  it("works from a real login through the UI's client", async () => {
    const user = await createTestUser();
    await grantPermissions(user.id, ["users.read"]);
    const ui = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: "tereo-ui" },
    });
    const token = await loginToken(
      { ...ui, plainSecret: null },
      user,
      "openid profile email offline_access"
    );
    expect((await call(token, "/v1/admin/users")).status).toBe(HTTP_STATUS.OK);
    expect((await call(token, "/v1/account/me")).status).toBe(HTTP_STATUS.OK);
  });
});

describe("a service's token", () => {
  it("acts with the service account's permissions, without any scope", async () => {
    const client = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
      scopes: [],
    });
    await makeServiceOf(client.id);
    const account = await prisma.user.findFirstOrThrow({
      where: { oauthClientId: client.id },
    });
    await grantPermissions(account.id, ["users.read"]);

    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${client.clientId}:${client.plainSecret}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    const { access_token } = (await res.json()) as { access_token: string };

    expect((await call(access_token, "/v1/admin/users")).status).toBe(
      HTTP_STATUS.OK
    );
    const write = await call(access_token, "/v1/admin/users", {
      method: "POST",
      body: "{}",
    });
    expect(write.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});

describe("a third-party token with core scopes", () => {
  it("carries core in its audience", async () => {
    const user = await createTestUser();
    const token = await loginToken(thirdParty, user, "openid core:account");
    expect(decodeJwt(token).aud).toBe("core");
  });

  it("gets no more than its scopes' ceiling", async () => {
    const user = await createTestUser();
    await grantPermissions(user.id, ["users.write", "file-service.admin"]);
    const token = await loginToken(thirdParty, user, "openid core:admin.read");

    // users.write is the user's; core:admin.read caps it at users.read.
    expect((await call(token, "/v1/admin/users")).status).toBe(HTTP_STATUS.OK);
    const write = await call(token, "/v1/admin/users", {
      method: "POST",
      body: "{}",
    });
    expect(write.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await errorOf(write)).toBe("forbidden");

    // Areas its scopes do not name are closed, whatever the user may do.
    for (const path of ["/v1/account/me", "/v1/files/buckets"]) {
      const res = await call(token, path);
      expect(res.status, path).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await errorOf(res)).toBe("insufficient_scope");
      expect(res.headers.get("www-authenticate")).toContain(
        'error="insufficient_scope"'
      );
    }
  });

  it("never exceeds the user's own permissions", async () => {
    const user = await createTestUser();
    await grantPermissions(user.id, ["roles.read"]);
    const token = await loginToken(thirdParty, user, "openid core:admin");
    expect((await call(token, "/v1/admin/roles")).status).toBe(HTTP_STATUS.OK);
    expect((await call(token, "/v1/admin/users")).status).toBe(
      HTTP_STATUS.FORBIDDEN
    );
  });

  it("cuts an administrator down to the scope's reads", async () => {
    const user = await createTestUser();
    await grantPermissions(user.id, ["admin"]);
    const token = await loginToken(thirdParty, user, "openid core:files.read");

    expect((await call(token, "/v1/files/buckets")).status).toBe(
      HTTP_STATUS.OK
    );
    const create = await call(token, "/v1/files/buckets", {
      method: "POST",
      body: JSON.stringify({ name: `ceiling-${Date.now()}` }),
    });
    expect(create.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect((await call(token, "/v1/admin/users")).status).toBe(
      HTTP_STATUS.FORBIDDEN
    );
  });

  it("reports a bucket grant no wider than core:files.read", async () => {
    const user = await createTestUser();
    const full = await grantPermissions(user.id, [
      "file-service.buckets.write",
      "file-service.objects.delete",
    ]);
    const name = `ceiling-grant-${Date.now()}`;
    const create = await call(full, "/v1/files/buckets", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    expect(create.status).toBe(HTTP_STATUS.CREATED);

    const token = await loginToken(thirdParty, user, "openid core:files.read");
    const res = await call(token, `/v1/files/buckets/${name}/my-permissions`);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(await res.json()).toStrictEqual({
      canRead: true,
      canWrite: false,
      canDelete: false,
    });

    // The full token still reports the creator's grant.
    const own = await call(full, `/v1/files/buckets/${name}/my-permissions`);
    expect(await own.json()).toStrictEqual({
      canRead: true,
      canWrite: true,
      canDelete: true,
    });
  });

  it("opens /account with core:account only", async () => {
    const user = await createTestUser();
    const token = await loginToken(thirdParty, user, "openid core:account");
    expect((await call(token, "/v1/account/me")).status).toBe(HTTP_STATUS.OK);
    expect(await errorOf(await call(token, "/v1/admin/users"))).toBe(
      "insufficient_scope"
    );
  });

  it("is introspected by its own confidential client with the user's live permissions", async () => {
    const confidential = await createTestClient({
      clientType: "confidential",
      scopes: ["openid", "profile", "email", ...ALL_CORE_SCOPES],
    });
    const user = await createTestUser();
    await grantPermissions(user.id, ["users.write"]);
    const token = await loginToken(confidential, user, "openid core:admin.read");
    const res = await introspect(confidential, token);
    const body = (await res.json()) as {
      active: boolean;
      permissions: string[];
    };
    expect(body.active).toBe(true);
    expect(body.permissions).toContain("users.write");
  });

  it("is not introspected by a public client, which cannot authenticate", async () => {
    const user = await createTestUser();
    const token = await loginToken(thirdParty, user, "openid core:admin.read");
    const res = await introspect(thirdParty, token);
    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await errorOf(res)).toBe("invalid_client");
  });
});

describe("introspecting a third-party token without core scopes", () => {
  it("tells its own client the user's claims, not core's permissions", async () => {
    const confidential = await createTestClient({
      clientType: "confidential",
      scopes: ["openid", "profile", "email"],
    });
    const user = await createTestUser();
    await grantPermissions(user.id, ["users.write"]);
    const token = await loginToken(confidential, user, "openid email");
    const body = (await (await introspect(confidential, token)).json()) as {
      active: boolean;
      email?: string;
      permissions?: string[];
    };
    expect(body.active).toBe(true);
    expect(body.email).toBe(user.email);
    expect(body).not.toHaveProperty("permissions");
  });

  it("tells a service in its audience the user's live permissions", async () => {
    const service = await createTestClient({
      clientType: "confidential",
      scopes: [],
    });
    const slug = await makeServiceOf(service.id);
    const login = await createTestClient({ scopes: ["openid"] });
    await prisma.oAuthClient.update({
      where: { id: login.id },
      data: { audience: [slug] },
    });
    const user = await createTestUser();
    await grantPermissions(user.id, ["users.write"]);
    const token = await loginToken(login, user, "openid");
    const body = (await (await introspect(service, token)).json()) as {
      active: boolean;
      permissions?: string[];
    };
    expect(body.active).toBe(true);
    expect(body.permissions).toContain("users.write");
  });
});
