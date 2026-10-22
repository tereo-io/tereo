// @module-tag int
// @module-tag auth
import { getUiAccessTokenForUser } from "../../support/auth/login.js";
import { createTestClient } from "../../support/auth/clients.js";
import { makeServiceOf } from "../../support/testService.js";
import { createTestUser } from "../../support/auth/users.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { hashFlowToken } from "../../../utils/crypto.js";
import { decodeJwt } from "../../support/auth/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateTotpCode,
  generateUniqueId,
} from "../../support/auth/crypto.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";

const REDIRECT_URI = "http://localhost:3000/session-lifecycle-callback";
const POST_LOGOUT_URI = "http://localhost:3000/session-lifecycle-logout";
// The tests call /account and /admin with these tokens.
const SCOPE = "openid profile email offline_access core:account core:admin";

type Jar = Map<string, string>;

interface TokenSet {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
}

interface TestUser {
  id: string;
  email: string;
  password: string;
  orgId: string;
}

let client: Awaited<ReturnType<typeof createTestClient>>;
let introspector: Awaited<ReturnType<typeof createTestClient>>;

const absorb = (jar: Jar, res: Response) => {
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
};

const cookieHeader = (jar: Jar) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

const userSessionCookieName = () => `tereo_user_session_${client.clientId}`;

const newPkce = () => {
  const verifier = generateCodeVerifier();
  return {
    verifier,
    challenge: generateCodeChallenge(verifier),
    state: generateUniqueId(),
  };
};

const authorizeUrl = (
  pkce: ReturnType<typeof newPkce>,
  extra: Record<string, string> = {}
) => {
  const url = new URL(`${BASE_URL}/oauth/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    state: pkce.state,
    scope: SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    ...extra,
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

const getAuthorize = async (
  jar: Jar,
  pkce: ReturnType<typeof newPkce>,
  extra: Record<string, string> = {}
) => {
  const res = await fetch(authorizeUrl(pkce, extra), {
    redirect: "manual",
    headers: { Cookie: cookieHeader(jar) },
  });
  absorb(jar, res);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
};

const createUser = async (): Promise<TestUser> => {
  const user = await createTestUser();
  const orgId = await ensureTestOrganization(`session-lifecycle-${user.id}`);
  await prisma.organizationMember.create({
    data: { organizationId: orgId, userId: user.id },
  });
  return {
    id: user.id,
    email: user.email,
    password: user.plainPassword,
    orgId,
  };
};

/** Approves a consent session; returns the authorization code. */
const approve = async (jar: Jar, sessionToken: string) => {
  const res = await fetch(`${BASE_URL}/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ session_token: sessionToken, approved: true }),
  });
  absorb(jar, res);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { redirect_url: string };
  const code = new URL(body.redirect_url).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
};

const exchange = async (code: string, verifier: string) => {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  return { status: res.status, body: (await res.json()) as TokenSet & Err };
};

interface Err {
  error?: string;
  error_description?: string;
}

const refresh = async (refreshToken: string) => {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.clientId,
      refresh_token: refreshToken,
    }),
  });
  return { status: res.status, body: (await res.json()) as TokenSet & Err };
};

const me = async (accessToken: string) => {
  const res = await fetch(`${BASE_URL}/v1/account/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return { status: res.status, body: (await res.json()) as Err };
};

/** Password login through to consent; returns the code and its verifier. */
const loginToCode = async (
  user: TestUser,
  jar: Jar,
  extra: Record<string, string> = {}
) => {
  const pkce = newPkce();
  const login = await getAuthorize(jar, pkce, extra);
  expect(login.pathname).toMatch(/\/login$/);

  const res = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      email: user.email,
      password: user.password,
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      state: pkce.state,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      ...extra,
    }),
  });
  absorb(jar, res);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { redirect_url: string };
  const session = new URL(body.redirect_url).searchParams.get("session");
  expect(session).toBeTruthy();
  const code = await approve(jar, session!);
  return { code, verifier: pkce.verifier };
};

/** A full password login. The jar keeps the SSO cookie it leaves behind. */
const login = async (user: TestUser, jar: Jar = new Map()) => {
  const { code, verifier } = await loginToCode(user, jar);
  const tokens = await exchange(code, verifier);
  expect(tokens.status).toBe(200);
  expect(tokens.body.refresh_token).toBeTruthy();
  return { jar, tokens: tokens.body };
};

/**
 * Tries to get tokens without a password: authorize with only the SSO cookie
 * (`prompt=none`, or the `org_id` org-switch path), then consent and exchange.
 * `loggedOut` means core sent the browser to the login page or answered
 * `login_required`. A `prompt=none` that accepts the session answers this
 * third-party client `consent_required`; tokens are then got by the org
 * switch to the session's user's organization, which shows consent.
 */
const silentLogin = async (
  jar: Jar,
  extra: Record<string, string> = { prompt: "none" }
) => {
  const pkce = newPkce();
  let location = await getAuthorize(jar, pkce, extra);
  const loggedOut = () =>
    location.pathname.endsWith("/login") ||
    location.searchParams.get("error") === "login_required";
  if (loggedOut()) return { loggedOut: true as const, location };
  if (location.searchParams.get("error") === "consent_required") {
    location = await getAuthorize(jar, pkce, {
      org_id: await ssoUserOrgId(jar),
    });
    if (loggedOut()) return { loggedOut: true as const, location };
  }
  expect(location.pathname).toMatch(/\/consent$/);
  const code = await approve(jar, location.searchParams.get("session")!);
  const tokens = await exchange(code, pkce.verifier);
  return { loggedOut: false as const, location, tokens };
};

/** The organization of the user whose SSO session the jar's cookie holds. */
const ssoUserOrgId = async (jar: Jar) => {
  const session = await prisma.userSession.findUniqueOrThrow({
    where: { tokenHash: hashFlowToken(jar.get(userSessionCookieName())!) },
  });
  const membership = await prisma.organizationMember.findFirstOrThrow({
    where: { userId: session.userId },
  });
  return membership.organizationId;
};

beforeAll(async () => {
  // A service in the login client's audience introspects its tokens.
  introspector = await createTestClient({ clientType: "confidential" });
  client = await createTestClient({
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [POST_LOGOUT_URI],
    audience: [await makeServiceOf(introspector.id)],
  });
});

describe("Session lifecycle", () => {
  describe("revocation endpoints", () => {
    const adminToken = () =>
      getTestPrincipalToken({ permissions: ["users.delete"] });

    it("DELETE /account/sessions/:id kills that session's tokens", async () => {
      const user = await createUser();
      const a = await login(user);
      const b = await login(user);
      const target = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: user.id, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      const res = await fetch(`${BASE_URL}/v1/account/sessions/${target.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.tokens.access_token}` },
      });
      expect(res.status).toBe(204);
      expect((await refresh(b.tokens.refresh_token)).status).toBe(400);
      expect((await me(b.tokens.access_token)).status).toBe(401);
      expect((await me(a.tokens.access_token)).status).toBe(200);
    });

    /** The session (refresh token id) a browser's access token belongs to. */
    const sessionIdOf = async (tokens: TokenSet) => {
      const { jti } = decodeJwt(tokens.access_token) as unknown as {
        jti: string;
      };
      const row = await prisma.accessToken.findUniqueOrThrow({
        where: { jti },
      });
      expect(row.refreshTokenId).toBeTruthy();
      return row.refreshTokenId!;
    };

    it("DELETE /account/sessions/:id also ends that browser's SSO session, and only that browser's", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);

      const res = await fetch(
        `${BASE_URL}/v1/account/sessions/${await sessionIdOf(phone.tokens)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${laptop.tokens.access_token}` },
        }
      );
      expect(res.status).toBe(204);

      expect((await refresh(phone.tokens.refresh_token)).status).toBe(400);
      expect((await silentLogin(phone.jar)).loggedOut).toBe(true);
      expect(
        (await silentLogin(phone.jar, { org_id: user.orgId })).loggedOut
      ).toBe(true);

      expect((await me(laptop.tokens.access_token)).status).toBe(200);
      const silent = await silentLogin(laptop.jar);
      expect(silent.loggedOut).toBe(false);
    });

    it("DELETE /account/sessions/:id revokes the families the browser got silently", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const other = await login(user);
      const silent = await silentLogin(laptop.jar, { org_id: user.orgId });
      expect(silent.loggedOut).toBe(false);
      const silentTokens = silent.loggedOut ? null : silent.tokens.body;
      expect(silentTokens?.refresh_token).toBeTruthy();

      const res = await fetch(
        `${BASE_URL}/v1/account/sessions/${await sessionIdOf(laptop.tokens)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${other.tokens.access_token}` },
        }
      );
      expect(res.status).toBe(204);
      expect((await refresh(silentTokens!.refresh_token)).status).toBe(400);
      expect((await me(silentTokens!.access_token)).status).toBe(401);
      expect((await me(other.tokens.access_token)).status).toBe(200);
    });

    it("DELETE /account/sessions/:id answers 404 for another user's session", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const ownerBrowser = await login(owner);
      const strangerBrowser = await login(stranger);

      const res = await fetch(
        `${BASE_URL}/v1/account/sessions/${await sessionIdOf(ownerBrowser.tokens)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${strangerBrowser.tokens.access_token}`,
          },
        }
      );
      expect(res.status).toBe(404);
      expect((await me(ownerBrowser.tokens.access_token)).status).toBe(200);
    });

    it("DELETE /admin/users/:id/sessions ends that browser's SSO session, and only that browser's", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);

      const res = await fetch(
        `${BASE_URL}/v1/admin/users/${user.id}/sessions`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await adminToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId: await sessionIdOf(phone.tokens) }),
        }
      );
      expect(res.status).toBe(204);

      expect((await refresh(phone.tokens.refresh_token)).status).toBe(400);
      expect((await me(phone.tokens.access_token)).status).toBe(401);
      expect((await silentLogin(phone.jar)).loggedOut).toBe(true);
      expect(
        (await silentLogin(phone.jar, { org_id: user.orgId })).loggedOut
      ).toBe(true);

      expect((await me(laptop.tokens.access_token)).status).toBe(200);
      expect((await silentLogin(laptop.jar)).loggedOut).toBe(false);
    });

    it("removing a member ends their sessions in that organization", async () => {
      const user = await createUser();
      const browser = await login(user);
      const { jti } = decodeJwt(browser.tokens.access_token) as unknown as {
        jti: string;
      };
      const row = await prisma.accessToken.findUniqueOrThrow({
        where: { jti },
      });
      expect(row.organizationId).toBe(user.orgId);

      const res = await fetch(
        `${BASE_URL}/v1/admin/organizations/${user.orgId}/members/${user.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await getTestPrincipalToken({
              permissions: ["organizations.write"],
            })}`,
          },
        }
      );
      expect(res.status).toBe(204);

      expect((await me(browser.tokens.access_token)).status).toBe(401);
      expect((await refresh(browser.tokens.refresh_token)).status).toBe(400);
      expect((await silentLogin(browser.jar)).loggedOut).toBe(true);

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: user.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "sessions_revoked" },
        },
      });
      expect(entry?.metadata).toMatchObject({
        sessionIds: [await sessionIdOf(browser.tokens)],
      });
    });

    it("single-session revokes are audited and emit auth.user.sessions-revoked", async () => {
      const user = await createUser();
      const browser = await login(user);
      const sessionId = await sessionIdOf(browser.tokens);

      const res = await fetch(
        `${BASE_URL}/v1/admin/users/${user.id}/sessions`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await adminToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        }
      );
      expect(res.status).toBe(204);

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: user.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "sessions_revoked" },
        },
      });
      expect(entry?.metadata).toMatchObject({ sessionIds: [sessionId] });
    });

    it("DELETE /account/sessions kills the other sessions' tokens", async () => {
      const user = await createUser();
      const a = await login(user);
      const b = await login(user);
      const res = await fetch(`${BASE_URL}/v1/account/sessions`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.tokens.access_token}` },
      });
      expect(res.status).toBe(200);
      expect((await refresh(b.tokens.refresh_token)).status).toBe(400);
      expect((await me(b.tokens.access_token)).status).toBe(401);
      expect((await me(a.tokens.access_token)).status).toBe(200);
    });

    it("DELETE /account/sessions also ends the other browsers' SSO sessions", async () => {
      const user = await createUser();
      const a = await login(user);
      const b = await login(user);
      await fetch(`${BASE_URL}/v1/account/sessions`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${a.tokens.access_token}` },
      });
      expect((await silentLogin(b.jar)).loggedOut).toBe(true);
    });

    it("DELETE /admin/users/:id/sessions/all kills every session's tokens", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      const res = await fetch(
        `${BASE_URL}/v1/admin/users/${user.id}/sessions/all`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await adminToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ includeCurrentSession: true }),
        }
      );
      expect(res.status).toBe(200);
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      expect((await me(tokens.access_token)).status).toBe(401);
    });

    it("DELETE /admin/users/:id/sessions/all also ends the SSO session", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await fetch(`${BASE_URL}/v1/admin/users/${user.id}/sessions/all`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${await adminToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ includeCurrentSession: true }),
      });
      expect((await silentLogin(jar)).loggedOut).toBe(true);
    });

    it("deactivating a user kills tokens, and the SSO session yields no new ones", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      const res = await fetch(`${BASE_URL}/v1/admin/users/${user.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await adminToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isActive: false }),
      });
      expect(res.status).toBe(200);
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      expect((await me(tokens.access_token)).status).toBe(401);
      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: user.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "sessions_revoked" },
        },
      });
      expect(entry?.metadata).toMatchObject({
        sessionIds: [await sessionIdOf(tokens)],
      });

      // prompt=none answers an inactive user's SSO cookie with login_required.
      const silent = await silentLogin(jar);
      expect(silent.loggedOut).toBe(true);
      expect(silent.location.searchParams.get("error")).toBe("login_required");
    });

    it("changing the password kills the other sessions' tokens", async () => {
      const user = await createUser();
      const attacker = await login(user);
      const owner = await login(user);
      const res = await fetch(`${BASE_URL}/v1/account/password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: user.password,
          newPassword: "An0ther-Long-Passw0rd!",
        }),
      });
      expect(res.status).toBe(200);
      expect((await refresh(attacker.tokens.refresh_token)).status).toBe(400);
      expect((await me(attacker.tokens.access_token)).status).toBe(401);
      expect((await me(owner.tokens.access_token)).status).toBe(200);
    });

    it("changing the password locks out a stolen SSO session", async () => {
      const user = await createUser();
      const attacker = await login(user);
      const owner = await login(user);
      await fetch(`${BASE_URL}/v1/account/password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: user.password,
          newPassword: "An0ther-Long-Passw0rd!",
        }),
      });
      const silent = await silentLogin(attacker.jar);
      expect(silent.loggedOut || silent.tokens.status !== 200).toBe(true);
    });

    it("enabling TOTP ends the other sessions", async () => {
      const user = await createUser();
      const other = await login(user);
      // 2FA setup is only for core's UI.
      const ownerToken = await getUiAccessTokenForUser({
        id: user.id,
        email: user.email,
        plainPassword: user.password,
      });
      const auth = {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      };
      const setupRes = await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers: auth,
      });
      expect(setupRes.status).toBe(200);
      const setup = (await setupRes.json()) as {
        secret: string;
        setupToken: string;
      };
      const verify = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          setupToken: setup.setupToken,
          totpCode: generateTotpCode(setup.secret),
        }),
      });
      expect(verify.status).toBe(200);
      expect((await refresh(other.tokens.refresh_token)).status).toBe(400);
    });
  });
});
