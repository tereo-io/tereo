import { makeServiceOf } from "../utils/testService.js";
import { FIXTURE_USER_IDS } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { getRedisClient } from "../../utils/redis.js";
import { prisma } from "../../utils/db/prisma.js";
import jwt from "jsonwebtoken";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
} from "../utils/browserLogin.js";
import {
  BASE_URL,
  addTestOrgMember,
  createAdminUser,
  createTestClient,
  createTestOrganization,
  createTestPermission,
  createTestRole,
  createTestUser,
  createUserRequiringTotpSetup,
  getAccessTokenForUser,
  generateTotpCode,
  loginToTotpSetup,
  startTotpSetup,
} from "./utils/test-helpers.js";

/**
 * The OAuth endpoints' edge cases: client authentication and its challenge,
 * PKCE and id formats, single-use codes and refresh tokens, scope narrowing,
 * deactivated service accounts, and what userinfo accepts.
 */

const SCOPE = "openid profile email offline_access";
const REDIRECT_URI = "http://localhost:3000/callback";
// RFC-variant-0 ids, like the fixtures': z.uuid() would reject them.
const VARIANT_ZERO_ID = "00000000-0000-7002-0000-000000000001";

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

const clientCredentialsToken = async (client: Client) => {
  const res = await postForm(
    "/oauth/token",
    { grant_type: "client_credentials" },
    { Authorization: basic(client) }
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
};

let publicClient: Client;
let ccClient: Client;
let user: Awaited<ReturnType<typeof createTestUser>>;

const loginAndExchange = async () => {
  const { code, verifier } = await browserLogin({
    clientId: publicClient.clientId,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    email: user.email,
    password: user.plainPassword,
  });
  const res = await postForm("/oauth/token", {
    grant_type: "authorization_code",
    client_id: publicClient.clientId,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
};

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

  it("marks token responses uncacheable", async () => {
    const res = await postForm(
      "/oauth/token",
      { grant_type: "client_credentials" },
      { Authorization: basic(ccClient) }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
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

describe("Authorization request validation", () => {
  const authorize = (overrides: Record<string, string>) => {
    const pkce = newPkce();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: publicClient.clientId,
      redirect_uri: REDIRECT_URI,
      state: pkce.state,
      scope: "openid",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      ...overrides,
    });
    return fetch(`${BASE_URL}/oauth/authorize?${params}`, {
      redirect: "manual",
    });
  };

  it("refuses a code_challenge that is not an S256 digest", async () => {
    const tooLong = await authorize({ code_challenge: "a".repeat(44) });
    expect(tooLong.status).toBe(400);
    const notBase64url = await authorize({ code_challenge: "+".repeat(43) });
    expect(notBase64url.status).toBe(400);
  });

  it("accepts an RFC-variant-0 org_id", async () => {
    const res = await authorize({ org_id: VARIANT_ZERO_ID });
    expect(res.status).toBe(302);
  });

  it("refuses the login of a client without the authorization_code grant", async () => {
    const pkce = newPkce();
    const res = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: ccClient.clientId,
        redirect_uri: REDIRECT_URI,
        state: pkce.state,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        email: user.email,
        password: user.plainPassword,
      }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("unauthorized_client");
  });

  it("refuses a code_verifier outside the RFC 7636 alphabet", async () => {
    const res = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: publicClient.clientId,
      code: "x",
      redirect_uri: REDIRECT_URI,
      code_verifier: `${"a".repeat(42)} `,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_request");
  });
});

describe("Single-use grants", () => {
  it("redeems a code once when two exchanges race", async () => {
    const { code, verifier } = await browserLogin({
      clientId: publicClient.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      email: user.email,
      password: user.plainPassword,
    });
    const exchange = () =>
      postForm("/oauth/token", {
        grant_type: "authorization_code",
        client_id: publicClient.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
    const statuses = (await Promise.all([exchange(), exchange()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 400]);
  });

  it("rotates a refresh token once when two refreshes race", async () => {
    const tokens = await loginAndExchange();
    const refresh = () =>
      postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: publicClient.clientId,
        refresh_token: tokens.refresh_token,
      });
    const statuses = (await Promise.all([refresh(), refresh()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 400]);
  });
});

describe("Refresh-token cookie", () => {
  const cookieRefresh = (cookie: string) =>
    postForm(
      "/oauth/token",
      { grant_type: "refresh_token", client_id: publicClient.clientId },
      { Cookie: cookie }
    );

  it("clears a refresh cookie that no longer refreshes", async () => {
    const tokens = await loginAndExchange();
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const res = await cookieRefresh(
      `trt_${publicClient.clientId}=${tokens.refresh_token}`
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_grant");
    const cleared = res.headers
      .getSetCookie()
      .filter((c) => /expires=Thu, 01 Jan 1970/i.test(c))
      .map((c) => c.split("=")[0]);
    expect(cleared).toEqual(
      expect.arrayContaining([
        `trt_${publicClient.clientId}`,
        `tsi_${publicClient.clientId}`,
      ])
    );
  });

  it("leaves the cookie when its token was just rotated by a concurrent refresh", async () => {
    const tokens = await loginAndExchange();
    const cookie = `trt_${publicClient.clientId}=${tokens.refresh_token}`;
    expect((await cookieRefresh(cookie)).status).toBe(200);

    const res = await cookieRefresh(cookie);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_grant");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("leaves the cookie alone for a body refresh token", async () => {
    const res = await postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: publicClient.clientId,
      refresh_token: "not-a-refresh-token",
    });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("Login step", () => {
  it("answers a missing login-session cookie with invalid_session", async () => {
    const pkce = newPkce();
    const res = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: publicClient.clientId,
        redirect_uri: REDIRECT_URI,
        state: pkce.state,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        email: user.email,
        password: user.plainPassword,
      }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_session");
  });
});

describe("Refresh scope", () => {
  it("narrows to a subset of the granted scopes", async () => {
    const tokens = await loginAndExchange();
    const res = await postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: publicClient.clientId,
      refresh_token: tokens.refresh_token,
      scope: "openid email",
    });
    expect(res.status).toBe(200);
    expect((await json(res)).scope).toBe("openid email");
  });

  it("refuses a scope the refresh token was not granted", async () => {
    const { code, verifier } = await browserLogin({
      clientId: publicClient.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid offline_access",
      email: user.email,
      password: user.plainPassword,
    });
    const exchanged = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: publicClient.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    const { refresh_token } = (await exchanged.json()) as {
      refresh_token: string;
    };

    const res = await postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: publicClient.clientId,
      refresh_token,
      scope: "openid email",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_scope");
  });
});

describe("UserInfo", () => {
  const userinfo = (token: string) =>
    fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  it("refuses a client_credentials token, which has no end user", async () => {
    const res = await userinfo(await clientCredentialsToken(ccClient));
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe("invalid_token");
    expect(res.headers.get("www-authenticate")).toMatch(
      /^Bearer error="invalid_token"/
    );
  });

  it("refuses the token of a user deactivated since", async () => {
    const other = await createTestUser();
    const { code, verifier } = await browserLogin({
      clientId: publicClient.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      email: other.email,
      password: other.plainPassword,
    });
    const exchanged = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: publicClient.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const { access_token } = (await exchanged.json()) as {
      access_token: string;
    };
    expect((await userinfo(access_token)).status).toBe(200);

    await prisma.user.update({
      where: { id: other.id },
      data: { isActive: false },
    });
    expect((await userinfo(access_token)).status).toBe(401);
  });

  it("refuses the access token of a revoked session", async () => {
    const tokens = await loginAndExchange();
    const revoked = await postForm("/oauth/revoke", {
      client_id: publicClient.clientId,
      token: tokens.refresh_token,
    });
    expect(revoked.status).toBe(200);
    expect((await userinfo(tokens.access_token)).status).toBe(401);
  });
});

describe("Introspection and revocation", () => {
  it("ignores an unknown token_type_hint", async () => {
    const token = await clientCredentialsToken(ccClient);
    const res = await postForm(
      "/oauth/introspect",
      { token, token_type_hint: "id_token" },
      { Authorization: basic(ccClient) }
    );
    expect(res.status).toBe(200);
    expect((await json(res)).active).toBe(true);
  });

  it("does not revoke by the jti of a forged token", async () => {
    const token = await clientCredentialsToken(ccClient);
    const {
      iat: _iat,
      exp: _exp,
      ...claims
    } = jwt.decode(token) as Record<string, unknown>;
    const forged = jwt.sign(claims, "not-core's-key", { algorithm: "HS256" });

    const revoke = await postForm(
      "/oauth/revoke",
      { token: forged },
      { Authorization: basic(ccClient) }
    );
    expect(revoke.status).toBe(200);

    const res = await postForm(
      "/oauth/introspect",
      { token },
      { Authorization: basic(ccClient) }
    );
    expect((await json(res)).active).toBe(true);
  });
});

describe("Check permission", () => {
  it("accepts RFC-variant-0 user and organization ids", async () => {
    const res = await fetch(`${BASE_URL}/oauth/check-permission`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic(ccClient),
      },
      body: JSON.stringify({
        user_id: FIXTURE_USER_IDS[0],
        permission: "users.read",
        organization_id: VARIANT_ZERO_ID,
      }),
    });
    // Past validation to the organization check: this client has none, so
    // it may not name one.
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe("forbidden");
  });

  it("caps a batch at 100 permissions", async () => {
    const res = await fetch(`${BASE_URL}/oauth/check-permission/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic(ccClient),
      },
      body: JSON.stringify({
        user_id: FIXTURE_USER_IDS[0],
        permissions: Array.from({ length: 101 }, (_, i) => `p${i}.read`),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Discovery and logout", () => {
  it("advertises no documentation URL core does not serve", async () => {
    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
    ]) {
      const doc = await json(await fetch(`${BASE_URL}${path}`));
      expect(doc).not.toHaveProperty("service_documentation");
    }
  });

  it("refuses an over-long post_logout_redirect_uri", async () => {
    const params = new URLSearchParams({
      client_id: publicClient.clientId,
      post_logout_redirect_uri: `http://localhost:3000/${"a".repeat(2100)}`,
    });
    const res = await fetch(`${BASE_URL}/oauth/end-session?${params}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });
});

describe("TOTP setup during login", () => {
  // Five attempts per user (credentialFailureLimits.test.ts covers the
  // lockout): four wrong codes leave room for the right one.
  it("counts wrong codes toward the lockout, clears them on success, and audits a spent recovery code", async () => {
    const totpUser = await createUserRequiringTotpSetup();
    const login = await loginToTotpSetup(totpUser, publicClient);
    const started = await startTotpSetup(
      { setup_grant: login.setupGrant },
      login.grantCookie
    );
    expect(started.status).toBe(200);
    const { secret, setupToken } = (await started.json()) as {
      secret: string;
      setupToken: string;
    };
    const right = generateTotpCode(secret);
    const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(
      6,
      "0"
    );

    const verify = (totp_code: string) =>
      fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setup_token: setupToken, totp_code }),
      });
    const failures = async () => {
      const redis = getRedisClient();
      const keys = await redis.keys("rl:totp:fail:*");
      const values = await Promise.all(keys.map((k) => redis.get(k)));
      return values.map(Number).reduce((sum, n) => sum + n, 0);
    };

    for (let i = 0; i < 4; i++) {
      expect((await verify(wrong)).status).toBe(401);
    }
    expect(await failures()).toBe(4);
    const enrolled = await verify(right);
    expect(enrolled.status).toBe(200);
    expect(await failures()).toBe(0);
    const { recoveryCodes } = (await enrolled.json()) as {
      recoveryCodes: string[];
    };

    // Signing in again, a recovery code stands in for the TOTP code, and
    // spending it is audited.
    const jar = new Map<string, string>();
    const pkce = newPkce();
    const params = {
      response_type: "code",
      client_id: publicClient.clientId,
      redirect_uri: REDIRECT_URI,
      state: pkce.state,
      scope: "openid",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    };
    const start = await fetch(
      `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
      { redirect: "manual" }
    );
    absorbCookies(jar, start);
    const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        ...params,
        email: totpUser.email,
        password: totpUser.plainPassword,
      }),
    });
    absorbCookies(jar, submit);
    const { redirect_url } = (await submit.json()) as { redirect_url: string };
    const session = new URL(redirect_url).searchParams.get("session");
    expect(new URL(redirect_url).pathname).toMatch(/\/login\/2fa$/);

    const recovered = await fetch(`${BASE_URL}/oauth/totp/recovery`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        session_token: session,
        recovery_code: recoveryCodes[0],
      }),
    });
    expect(recovered.status).toBe(200);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "User", entityId: totpUser.id },
    });
    const used = entries.filter(
      (e) =>
        (e.metadata as { action?: string } | null)?.action ===
        "recovery_code_used"
    );
    expect(used).toHaveLength(1);
    expect(used[0].userId).toBe(totpUser.id);
  });
});

describe("Redirect URI schemes", () => {
  it("refuses a script-capable redirect URI even when it is registered", async () => {
    // Registered before the admin schema refused them.
    const uri = "javascript://x/%0aalert(document.domain)";
    const client = await createTestClient({ redirectUris: [uri] });
    const pkce = newPkce();
    const params = {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: uri,
      state: pkce.state,
      scope: "openid",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    };

    const start = await fetch(
      `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
      { redirect: "manual" }
    );
    expect(start.status).toBe(400);
    expect((await json(start)).error).toBe("invalid_request");

    const jar = new Map<string, string>([
      [`tereo_session_${client.clientId}`, "x"],
    ]);
    const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        ...params,
        email: user.email,
        password: user.plainPassword,
      }),
    });
    expect(submit.status).toBe(400);
    expect(JSON.stringify(await json(submit))).not.toContain("redirect_url");
  });

  it("refuses a script-capable post_logout_redirect_uri", async () => {
    const uri = "javascript:alert(1)";
    const client = await createTestClient({ postLogoutRedirectUris: [uri] });
    const res = await fetch(
      `${BASE_URL}/oauth/end-session?${new URLSearchParams({
        client_id: client.clientId,
        post_logout_redirect_uri: uri,
      })}`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(400);
  });
});

describe("Token types", () => {
  it("refuses an ID token as a bearer token, and introspects it as inactive", async () => {
    const { code, verifier } = await browserLogin({
      clientId: publicClient.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      email: user.email,
      password: user.plainPassword,
    });
    const exchanged = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: publicClient.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const { id_token } = (await exchanged.json()) as { id_token: string };
    expect(id_token).toBeTruthy();

    const userinfo = await fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${id_token}` },
    });
    expect(userinfo.status).toBe(401);
    expect((await json(userinfo)).error).toBe("invalid_token");

    const account = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${id_token}` },
    });
    expect(account.status).toBe(401);

    const introspected = await postForm(
      "/oauth/introspect",
      { token: id_token },
      { Authorization: basic(ccClient) }
    );
    expect(introspected.status).toBe(200);
    expect(await json(introspected)).toEqual({ active: false });
  });
});

describe("Introspection permissions", () => {
  it("reports the user's live permissions", async () => {
    const holder = await createTestUser();
    const role = await createTestRole();
    const permission = await createTestPermission();
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    const assignment = await prisma.userRole.create({
      data: { userId: holder.id, roleId: role.id },
    });

    // Introspected by a service in the login client's audience.
    const service = await createTestClient({ clientType: "confidential" });
    const login = await createTestClient({
      redirectUris: [REDIRECT_URI],
      audience: [await makeServiceOf(service.id)],
    });
    const { code, verifier } = await browserLogin({
      clientId: login.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      email: holder.email,
      password: holder.plainPassword,
    });
    const exchanged = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: login.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const { access_token } = (await exchanged.json()) as {
      access_token: string;
    };
    const introspect = async () =>
      (await json(
        await postForm(
          "/oauth/introspect",
          { token: access_token },
          { Authorization: basic(service) }
        )
      )) as { active: boolean; permissions: string[] };

    expect((await introspect()).permissions).toContain(permission.name);

    await prisma.userRole.delete({ where: { id: assignment.id } });
    const after = await introspect();
    expect(after.active).toBe(true);
    expect(after.permissions).not.toContain(permission.name);
    expect(jwt.decode(access_token)).not.toHaveProperty("permissions");
  });

  it("answers inactive for a token longer than 2048 characters, rather than refusing it", async () => {
    const res = await postForm(
      "/oauth/introspect",
      { token: `eyJ.${"a".repeat(3000)}.sig` },
      { Authorization: basic(ccClient) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
  });
});

describe("ID token claims", () => {
  const exchange = async (scope: string) => {
    const { code, verifier } = await browserLogin({
      clientId: publicClient.clientId,
      redirectUri: REDIRECT_URI,
      scope,
      email: user.email,
      password: user.plainPassword,
    });
    const res = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: publicClient.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id_token: string; refresh_token: string };
  };

  const claimsOf = (token: string) =>
    jwt.decode(token) as Record<string, unknown>;

  it("carries the profile and email claims only for their scopes", async () => {
    const bare = claimsOf((await exchange("openid")).id_token);
    expect(bare.sub).toBe(user.id);
    for (const claim of ["email", "email_verified", "name", "updated_at"]) {
      expect(bare).not.toHaveProperty(claim);
    }

    const email = claimsOf((await exchange("openid email")).id_token);
    expect(email.email).toBe(user.email);
    expect(email).not.toHaveProperty("name");

    const profile = claimsOf((await exchange("openid profile")).id_token);
    expect(profile.name).toBe(user.name);
    expect(profile).not.toHaveProperty("email");
  });

  it("follows a refresh's narrowed scope", async () => {
    const { refresh_token } = await exchange(SCOPE);
    const res = await postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: publicClient.clientId,
      refresh_token,
      scope: "openid",
    });
    expect(res.status).toBe(200);
    const claims = claimsOf(
      ((await res.json()) as { id_token: string }).id_token
    );
    expect(claims).not.toHaveProperty("email");
    expect(claims).not.toHaveProperty("name");
  });
});

describe("Refresh scope rotation", () => {
  const refresh = (refresh_token: string, scope?: string) =>
    postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: publicClient.clientId,
      refresh_token,
      ...(scope && { scope }),
    });

  it("keeps the whole grant on the rotated refresh token after a narrowed refresh", async () => {
    const tokens = await loginAndExchange();
    const narrowed = await refresh(tokens.refresh_token, "openid");
    expect(narrowed.status).toBe(200);
    const body = (await narrowed.json()) as {
      scope: string;
      refresh_token: string;
    };
    expect(body.scope).toBe("openid");

    const full = await refresh(body.refresh_token);
    expect(full.status).toBe(200);
    expect((await json(full)).scope).toBe(SCOPE);
  });

  it("drops a scope withdrawn from the client since the grant", async () => {
    const client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    const { code, verifier } = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid offline_access core:account",
      email: user.email,
      password: user.plainPassword,
    });
    const exchanged = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: client.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    const { refresh_token } = (await exchanged.json()) as {
      refresh_token: string;
    };
    await prisma.oAuthClient.update({
      where: { id: client.id },
      data: { scopes: client.scopes.filter((s) => s !== "core:account") },
    });

    const asked = await postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.clientId,
      refresh_token,
      scope: "openid core:account",
    });
    expect(asked.status).toBe(200);
    const narrowed = (await asked.json()) as {
      scope: string;
      access_token: string;
      refresh_token: string;
    };
    expect(narrowed.scope).toBe("openid");
    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${narrowed.access_token}` },
    });
    expect(me.status).not.toBe(200);

    const rotated = await postForm("/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.clientId,
      refresh_token: narrowed.refresh_token,
    });
    expect(rotated.status).toBe(200);
    expect((await json(rotated)).scope).toBe("openid offline_access");
  });

  it("does not spend the refresh token on a refused scope", async () => {
    const tokens = await loginAndExchange();
    const refused = await refresh(tokens.refresh_token, "openid admin");
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toBe("invalid_scope");

    expect((await refresh(tokens.refresh_token)).status).toBe(200);
  });
});

describe("Organization of a code", () => {
  const loginToOrg = async () => {
    const admin = await createAdminUser();
    const adminToken = await getAccessTokenForUser(admin, publicClient);
    const org = await createTestOrganization(adminToken);
    const member = await createTestUser();
    await addTestOrgMember(adminToken, org.id, member.id);

    const { code, verifier } = await browserLogin({
      clientId: publicClient.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      email: member.email,
      password: member.plainPassword,
    });
    const stored = await prisma.authorizationCode.findFirstOrThrow({
      where: { userId: member.id },
    });
    expect(stored.organizationId).toBe(org.id);
    return { org, member, code, verifier };
  };

  const exchange = (code: string, verifier: string) =>
    postForm("/oauth/token", {
      grant_type: "authorization_code",
      client_id: publicClient.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });

  it("refuses to exchange a code for an organization the user has left since", async () => {
    const { org, member, code, verifier } = await loginToOrg();
    await prisma.organizationMember.delete({
      where: {
        organizationId_userId: { organizationId: org.id, userId: member.id },
      },
    });

    const res = await exchange(code, verifier);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_grant");
  });

  it("mints no client_credentials token for a client whose organization is inactive", async () => {
    const admin = await createAdminUser();
    const adminToken = await getAccessTokenForUser(admin, publicClient);
    const org = await createTestOrganization(adminToken);
    const service = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    await prisma.oAuthClient.update({
      where: { id: service.id },
      data: { organizationId: org.id },
    });
    expect(await clientCredentialsToken(service)).toBeTruthy();

    await prisma.organization.update({
      where: { id: org.id },
      data: { isActive: false },
    });
    const res = await postForm(
      "/oauth/token",
      { grant_type: "client_credentials" },
      { Authorization: basic(service) }
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("unauthorized_client");
  });

  it("refuses to exchange a code for an organization deactivated since", async () => {
    const { org, code, verifier } = await loginToOrg();
    await prisma.organization.update({
      where: { id: org.id },
      data: { isActive: false },
    });

    const res = await exchange(code, verifier);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_grant");
  });
});
