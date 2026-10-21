import { describe, it, expect, beforeAll } from "vitest";
import { confirmLogout } from "../utils/browserLogin.js";
import { hashFlowToken } from "../../utils/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import env from "../../env.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
  decodeJwt,
  generateCodeChallenge,
  generateCodeVerifier,
  generateTotpCode,
  generateUniqueId,
  getUiAccessTokenForUser,
} from "./utils/test-helpers.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";
import {
  ID_TOKEN_HINT_GRACE_SECONDS,
  generateAccessToken,
  generateIdToken,
} from "../../utils/tokens.js";

/**
 * Session lifecycle: how long each credential lives, and whether logout and
 * the revocation endpoints actually end a session. Every flow here is the real
 * browser flow (authorize → login → consent → token) with a cookie jar, and
 * expiry is simulated by moving `expires_at` / `auth_time` in the database.
 *
 * Tests marked `it.fails` demonstrate a bug; each names it.
 */

const REDIRECT_URI = "http://localhost:3000/session-lifecycle-callback";
const POST_LOGOUT_URI = "http://localhost:3000/session-lifecycle-logout";
// The tests call /account and /admin with these tokens.
const SCOPE = "openid profile email offline_access core:account core:admin";
const USER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

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

const userSessionRows = (userId: string) =>
  prisma.userSession.findMany({ where: { userId } });

beforeAll(async () => {
  client = await createTestClient({
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [POST_LOGOUT_URI],
  });
});

describe("Session lifecycle", () => {
  describe("token lifetimes", () => {
    it("issues access and ID tokens for JWT_ACCESS_TOKEN_TTL", async () => {
      const { tokens } = await login(await createUser());
      const access = decodeJwt(tokens.access_token);
      const id = decodeJwt(tokens.id_token!);
      expect(tokens.expires_in).toBe(env.JWT_ACCESS_TOKEN_TTL);
      expect(access.exp - access.iat).toBe(env.JWT_ACCESS_TOKEN_TTL);
      expect(id.exp - id.iat).toBe(env.JWT_ACCESS_TOKEN_TTL);
    });

    it("stores refresh tokens for JWT_REFRESH_TOKEN_TTL and SSO sessions for 7 days", async () => {
      const user = await createUser();
      await login(user);
      const [rt] = await prisma.refreshToken.findMany({
        where: { userId: user.id },
      });
      const lifetime = rt.expiresAt.getTime() - rt.createdAt.getTime();
      expect(
        Math.abs(lifetime - env.JWT_REFRESH_TOKEN_TTL * 1000)
      ).toBeLessThan(5000);

      const [session] = await userSessionRows(user.id);
      const ssoLifetime =
        session.expiresAt.getTime() - session.createdAt.getTime();
      expect(
        Math.abs(ssoLifetime - USER_SESSION_TTL_SECONDS * 1000)
      ).toBeLessThan(5000);
    });

    it("stores authorization codes for AUTHORIZATION_CODE_TTL", async () => {
      const user = await createUser();
      await loginToCode(user, new Map());
      const [code] = await prisma.authorizationCode.findMany({
        where: { userId: user.id },
      });
      const lifetime = code.expiresAt.getTime() - code.createdAt.getTime();
      expect(
        Math.abs(lifetime - env.AUTHORIZATION_CODE_TTL * 1000)
      ).toBeLessThan(5000);
    });
  });

  describe("login flow lifetime", () => {
    const maxAgeOf = (res: Response, prefix: string) => {
      const cookie = res.headers
        .getSetCookie()
        .find((c) => c.startsWith(prefix));
      return Number(/Max-Age=(\d+)/i.exec(cookie ?? "")?.[1]);
    };

    it("keeps the login and consent steps for LOGIN_FLOW_TTL, the code for AUTHORIZATION_CODE_TTL", async () => {
      expect(env.LOGIN_FLOW_TTL).toBeGreaterThan(env.AUTHORIZATION_CODE_TTL);
      const user = await createUser();
      const jar: Jar = new Map();
      const pkce = newPkce();

      const start = await fetch(authorizeUrl(pkce), {
        redirect: "manual",
        headers: { Cookie: cookieHeader(jar) },
      });
      absorb(jar, start);
      expect(maxAgeOf(start, "tereo_session_")).toBe(env.LOGIN_FLOW_TTL);

      const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({
          email: user.email,
          password: user.password,
          client_id: client.clientId,
          redirect_uri: REDIRECT_URI,
          state: pkce.state,
          scope: SCOPE,
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
        }),
      });
      absorb(jar, submit);
      expect(submit.status).toBe(200);
      expect(maxAgeOf(submit, "tereo_consent_session_")).toBe(
        env.LOGIN_FLOW_TTL
      );
      const consent = await prisma.consentSession.findFirstOrThrow({
        where: { userId: user.id },
      });
      const flowLifetime =
        consent.expiresAt.getTime() - consent.createdAt.getTime();
      expect(Math.abs(flowLifetime - env.LOGIN_FLOW_TTL * 1000)).toBeLessThan(
        5000
      );

      const { redirect_url } = (await submit.json()) as {
        redirect_url: string;
      };
      await approve(jar, new URL(redirect_url).searchParams.get("session")!);
      const code = await prisma.authorizationCode.findFirstOrThrow({
        where: { userId: user.id },
      });
      const codeLifetime = code.expiresAt.getTime() - code.createdAt.getTime();
      expect(
        Math.abs(codeLifetime - env.AUTHORIZATION_CODE_TTL * 1000)
      ).toBeLessThan(5000);
    });
  });

  describe("expiry in practice", () => {
    const mintExpired = async (userId: string, secondsAgo: number) => {
      const { token, jti, expiresAt } = generateAccessToken({
        subject: userId,
        clientId: client.clientId,
        scopes: [],
        expiresIn: -secondsAgo,
      });
      await prisma.accessToken.create({
        data: { jti, clientId: client.id, userId, scopes: [], expiresAt },
      });
      return token;
    };

    it("rejects an expired access token with 401 invalid_token", async () => {
      const user = await createUser();
      const res = await me(await mintExpired(user.id, 60));
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid_token");
    });

    it("allows no clock skew: a token one second past exp is rejected", async () => {
      const user = await createUser();
      const res = await me(await mintExpired(user.id, 1));
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid_token");
    });

    it("rejects an expired refresh token with invalid_grant", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      await prisma.refreshToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await refresh(tokens.refresh_token);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("rejects an expired authorization code with invalid_grant", async () => {
      const user = await createUser();
      const { code, verifier } = await loginToCode(user, new Map());
      await prisma.authorizationCode.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await exchange(code, verifier);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("forces a fresh login once the SSO session has expired", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await prisma.userSession.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const expired = jar.get(userSessionCookieName())!;
      const promptNone = await silentLogin(jar);
      expect(promptNone.loggedOut).toBe(true);

      // prompt=none cleared the cookie; put the expired one back.
      jar.set(userSessionCookieName(), expired);
      const orgSwitch = await silentLogin(jar, { org_id: user.orgId });
      expect(orgSwitch.loggedOut).toBe(true);
    });

    it("does not extend the SSO session past its original expiry", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      const soon = new Date(Date.now() + 60_000);
      await prisma.userSession.updateMany({
        where: { userId: user.id },
        data: { expiresAt: soon },
      });

      const result = await silentLogin(jar);
      expect(result.loggedOut).toBe(false);
      const latest = await prisma.userSession.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
      });
      expect(latest!.expiresAt.getTime()).toBeLessThanOrEqual(soon.getTime());
    });
  });

  describe("refresh", () => {
    it("rotates the refresh token and revokes the family when an old one is replayed", async () => {
      const user = await createUser();
      const { tokens } = await login(user);

      const first = await refresh(tokens.refresh_token);
      expect(first.status).toBe(200);
      expect(first.body.refresh_token).not.toBe(tokens.refresh_token);

      // Past the grace period for a concurrent refresh.
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, rotatedAt: { not: null } },
        data: { rotatedAt: new Date(Date.now() - 60_000) },
      });
      const replay = await refresh(tokens.refresh_token);
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");

      const successor = await refresh(first.body.refresh_token);
      expect(successor.status).toBe(400);
      expect((await me(first.body.access_token)).status).toBe(401);
    });

    it("does not extend a refresh token family past its original expiry", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      const soon = new Date(Date.now() + 60_000);
      await prisma.refreshToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: soon },
      });

      const rotated = await refresh(tokens.refresh_token);
      expect(rotated.status).toBe(200);
      const latest = await prisma.refreshToken.findFirst({
        where: { userId: user.id, revokedAt: null },
      });
      expect(latest!.expiresAt.getTime()).toBeLessThanOrEqual(soon.getTime());
    });

    it("refuses to refresh for an inactive user", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      await prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });
      const res = await refresh(tokens.refresh_token);
      expect(res.status).toBe(400);
    });

    it("answers a superseded access token with 401 invalid_token", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      expect((await refresh(tokens.refresh_token)).status).toBe(200);
      const res = await me(tokens.access_token);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid_token");
    });

    it("introspection agrees with requireAuth after rotation", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      expect((await refresh(tokens.refresh_token)).status).toBe(200);
      expect((await me(tokens.access_token)).status).not.toBe(200);

      const res = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.access_token,
          client_id: client.clientId,
        }),
      });
      const body = (await res.json()) as { active: boolean };
      expect(body.active).toBe(false);
    });
  });

  describe("logout (/oauth/end-session)", () => {
    const expectFullyLoggedOut = async (
      user: TestUser,
      jar: Jar,
      tokens: TokenSet
    ) => {
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      const access = await me(tokens.access_token);
      expect(access.status).toBe(401);
      expect(access.body.error).toBe("invalid_token");
      expect(await userSessionRows(user.id)).toHaveLength(0);
      expect((await silentLogin(jar)).loggedOut).toBe(true);
      expect((await silentLogin(jar, { org_id: user.orgId })).loggedOut).toBe(
        true
      );
    };

    it("with id_token_hint: revokes tokens and the SSO session at once", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      const ssoCookie = jar.get(userSessionCookieName());

      const url = new URL(`${BASE_URL}/oauth/end-session`);
      url.searchParams.set("id_token_hint", tokens.id_token!);
      url.searchParams.set("post_logout_redirect_uri", POST_LOGOUT_URI);
      const res = await fetch(url, {
        redirect: "manual",
        headers: { Cookie: cookieHeader(jar) },
      });
      expect(res.status).toBe(302);
      absorb(jar, res);
      expect(jar.has(userSessionCookieName())).toBe(false);

      // A browser that ignored the cleared cookie still gets nothing.
      jar.set(userSessionCookieName(), ssoCookie!);
      await expectFullyLoggedOut(user, jar, tokens);
    });

    it("with client_id and the SSO cookie only: same outcome once the user confirms", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      const ssoCookie = jar.get(userSessionCookieName());

      const res = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({ client_id: client.clientId }),
        redirect: "manual",
      });
      expect((await confirmLogout(jar, res)).status).toBe(200);

      jar.set(userSessionCookieName(), ssoCookie!);
      await expectFullyLoggedOut(user, jar, tokens);
    });

    /** The admin UI's call: a form post with its cookies, client_id and hint. */
    const endSession = async (
      jar: Jar,
      params: Record<string, string> = {}
    ) => {
      const res = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader(jar),
        },
        body: new URLSearchParams(params),
        redirect: "manual",
      });
      absorb(jar, res);
      return res;
    };

    const revokeRefresh = (refreshToken: string) =>
      fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          token: refreshToken,
        }),
      });

    const expectStillSignedIn = async (browser: {
      jar: Jar;
      tokens: TokenSet;
    }) => {
      expect((await me(browser.tokens.access_token)).status).toBe(200);
      expect((await refresh(browser.tokens.refresh_token)).status).toBe(200);
      const silent = await silentLogin(browser.jar);
      expect(silent.loggedOut).toBe(false);
      if (!silent.loggedOut) expect(silent.tokens.status).toBe(200);
    };

    const expectBrowserLoggedOut = async (
      user: TestUser,
      browser: { jar: Jar; tokens: TokenSet },
      ssoCookie: string
    ) => {
      expect((await refresh(browser.tokens.refresh_token)).status).toBe(400);
      expect((await me(browser.tokens.access_token)).status).toBe(401);
      // Even a browser that ignored the cleared cookie gets nothing.
      browser.jar.set(userSessionCookieName(), ssoCookie);
      expect((await silentLogin(browser.jar)).loggedOut).toBe(true);
      expect(
        (await silentLogin(browser.jar, { org_id: user.orgId })).loggedOut
      ).toBe(true);
    };

    it("logs out only this browser: another browser stays signed in", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;

      const res = await endSession(laptop.jar, {
        client_id: client.clientId,
        id_token_hint: laptop.tokens.id_token!,
      });
      expect(res.status).toBe(200);
      expect(laptop.jar.has(userSessionCookieName())).toBe(false);

      await expectBrowserLoggedOut(user, laptop, laptopSso);
      await expectStillSignedIn(phone);
    });

    it("with only the hint (no cookies): its sid names the browser", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;

      const res = await endSession(new Map(), {
        id_token_hint: laptop.tokens.id_token!,
      });
      expect(res.status).toBe(200);

      await expectBrowserLoggedOut(user, laptop, laptopSso);
      await expectStillSignedIn(phone);
    });

    it("revokes every token family the browser obtained, silent logins included", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;
      const silent = await silentLogin(laptop.jar, { org_id: user.orgId });
      expect(silent.loggedOut).toBe(false);
      if (silent.loggedOut) return;
      expect(silent.tokens.status).toBe(200);

      const confirmed = await confirmLogout(
        laptop.jar,
        await endSession(laptop.jar, { client_id: client.clientId })
      );
      expect(confirmed.status).toBe(200);

      expect((await refresh(silent.tokens.body.refresh_token)).status).toBe(
        400
      );
      await expectBrowserLoggedOut(user, laptop, laptopSso);
    });

    it("works after /oauth/revoke already revoked the refresh token (the UI's race)", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;

      expect((await revokeRefresh(laptop.tokens.refresh_token)).status).toBe(
        200
      );
      const res = await endSession(laptop.jar, {
        client_id: client.clientId,
        id_token_hint: laptop.tokens.id_token!,
      });
      expect(res.status).toBe(200);

      await expectBrowserLoggedOut(user, laptop, laptopSso);
      await expectStillSignedIn(phone);
    });

    it("works before /oauth/revoke, which then still succeeds", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;

      const res = await endSession(laptop.jar, {
        client_id: client.clientId,
        id_token_hint: laptop.tokens.id_token!,
      });
      expect(res.status).toBe(200);
      expect((await revokeRefresh(laptop.tokens.refresh_token)).status).toBe(
        200
      );

      await expectBrowserLoggedOut(user, laptop, laptopSso);
      await expectStillSignedIn(phone);
    });

    it("with nothing that identifies a browser, revokes nothing", async () => {
      const user = await createUser();
      const laptop = await login(user);

      const jar: Jar = new Map();
      const res = await confirmLogout(
        jar,
        await endSession(jar, { client_id: client.clientId })
      );
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { redirect_url: unknown }).redirect_url
      ).toBe(null);

      await expectStillSignedIn(laptop);
    });

    it("asks to confirm for a hint expired past the grace period", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const { sid } = decodeJwt(laptop.tokens.id_token!) as { sid?: string };
      expect(sid).toBeTruthy();
      const stale = generateIdToken({
        subject: user.id,
        clientId: client.clientId,
        sessionId: sid,
        expiresIn: -(ID_TOKEN_HINT_GRACE_SECONDS + 60),
      }).token;

      const res = await endSession(new Map(), { id_token_hint: stale });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location") ?? "").pathname).toMatch(
        /\/logout$/
      );
      await expectStillSignedIn(laptop);
    });

    it("accepts a hint expired within the grace period", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;
      const { sid } = decodeJwt(laptop.tokens.id_token!) as { sid?: string };
      const lapsed = generateIdToken({
        subject: user.id,
        clientId: client.clientId,
        sessionId: sid,
        expiresIn: -60,
      }).token;

      const res = await endSession(new Map(), { id_token_hint: lapsed });
      expect(res.status).toBe(200);
      await expectBrowserLoggedOut(user, laptop, laptopSso);
    });

    it("answers 400 invalid_request with neither client_id nor id_token_hint", async () => {
      const res = await endSession(new Map());
      expect(res.status).toBe(400);
      expect(((await res.json()) as Err).error).toBe("invalid_request");
    });
  });

  describe("admin UI logout (/oauth/revoke with the refresh cookie)", () => {
    it("revokes the refresh token and its access tokens", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      const res = await fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
        }),
      });
      expect(res.status).toBe(200);
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      expect((await me(tokens.access_token)).status).toBe(401);
    });

    it("leaves no way back in without a password", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      await fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          token: tokens.refresh_token,
        }),
      });
      const result = await silentLogin(jar, { org_id: user.orgId });
      expect(result.loggedOut).toBe(true);
    });
  });

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

  describe("max_age and prompt=login", () => {
    it("prompt=none with max_age older than the SSO login returns login_required", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await prisma.userSession.updateMany({
        where: { userId: user.id },
        data: { authTime: new Date(Date.now() - 3600_000) },
      });
      const location = await getAuthorize(jar, newPkce(), {
        prompt: "none",
        max_age: "60",
      });
      expect(location.searchParams.get("error")).toBe("login_required");
    });

    it("prompt=login sends the user to login without ending the SSO session", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      const cookie = jar.get(userSessionCookieName());
      const location = await getAuthorize(jar, newPkce(), { prompt: "login" });
      expect(location.pathname).toMatch(/\/login$/);
      // An abandoned login leaves the browser signed in.
      expect(await userSessionRows(user.id)).toHaveLength(1);
      expect(jar.get(userSessionCookieName())).toBe(cookie);
      expect((await silentLogin(jar)).loggedOut).toBe(false);
    });

    it("a password login in a signed-in browser issues a new SSO cookie token", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      const [before] = await userSessionRows(user.id);
      const oldToken = jar.get(userSessionCookieName())!;

      await login(user, jar);
      const newToken = jar.get(userSessionCookieName())!;
      expect(newToken).not.toBe(oldToken);
      // The browser keeps its one session row.
      const after = await userSessionRows(user.id);
      expect(after.map((s) => s.id)).toEqual([before.id]);

      const stale: Jar = new Map([[userSessionCookieName(), oldToken]]);
      expect((await silentLogin(stale)).loggedOut).toBe(true);
      const fresh: Jar = new Map([[userSessionCookieName(), newToken]]);
      expect((await silentLogin(fresh)).loggedOut).toBe(false);
    });

    it("a silent login keeps the SSO cookie token", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      const token = jar.get(userSessionCookieName());
      expect((await silentLogin(jar)).loggedOut).toBe(false);
      expect(jar.get(userSessionCookieName())).toBe(token);
    });

    it("prompt=login with org_id still asks for the password", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      const location = await getAuthorize(jar, newPkce(), {
        prompt: "login",
        org_id: user.orgId,
      });
      expect(location.pathname).toMatch(/\/login$/);
    });

    it("a completed prompt=login replaces the SSO session with a fresh login", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      const [before] = await userSessionRows(user.id);

      const { code, verifier } = await loginToCode(user, jar, {
        prompt: "login",
      });
      expect((await exchange(code, verifier)).status).toBe(200);

      const after = await userSessionRows(user.id);
      expect(after).toHaveLength(1);
      expect(after[0].authTime.getTime()).toBeGreaterThan(
        before.authTime.getTime()
      );
    });

    it("a completed prompt=login as another user ends the previous user's SSO session", async () => {
      const first = await createUser();
      const second = await createUser();
      const { jar, tokens } = await login(first);

      const { code, verifier } = await loginToCode(second, jar, {
        prompt: "login",
      });
      expect((await exchange(code, verifier)).status).toBe(200);

      expect(await userSessionRows(first.id)).toHaveLength(0);
      expect(await userSessionRows(second.id)).toHaveLength(1);
      // Its token families end with it, as at a logout of this browser.
      const family = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashFlowToken(tokens.refresh_token) },
      });
      expect(family?.revokedAt).not.toBeNull();
      const access = await fetch(`${BASE_URL}/v1/account/me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      expect(access.status).toBe(401);
    });

    it("max_age on a password login is satisfied by the fresh auth_time", async () => {
      const user = await createUser();
      const { code, verifier } = await loginToCode(user, new Map(), {
        max_age: "60",
      });
      const res = await exchange(code, verifier);
      expect(res.status).toBe(200);
      const id = decodeJwt(res.body.id_token!);
      expect(Math.floor(Date.now() / 1000) - id.auth_time!).toBeLessThan(60);
    });

    it("org-switch with a stale login and max_age forces re-authentication", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await prisma.userSession.updateMany({
        where: { userId: user.id },
        data: { authTime: new Date(Date.now() - 3600_000) },
      });
      const silent = await silentLogin(jar, {
        org_id: user.orgId,
        max_age: "60",
      });
      expect(silent.loggedOut).toBe(true);
      expect(silent.location.pathname).toMatch(/\/login$/);
    });

    it("the token endpoint does not re-apply max_age after an interactive login", async () => {
      const user = await createUser();
      const { code, verifier } = await loginToCode(user, new Map(), {
        max_age: "0",
      });
      await prisma.authorizationCode.updateMany({
        where: { userId: user.id },
        data: { authTime: new Date(Date.now() - 30_000) },
      });
      const res = await exchange(code, verifier);
      expect(res.status).toBe(200);
    });
  });

  describe("inactive users", () => {
    it("prompt=none for an inactive user returns login_required", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });
      const location = await getAuthorize(jar, newPkce(), { prompt: "none" });
      expect(location.searchParams.get("error")).toBe("login_required");
    });

    it("org-switch for an inactive user sends them to the login page", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });
      const silent = await silentLogin(jar, { org_id: user.orgId });
      expect(silent.loggedOut).toBe(true);
      expect(silent.location.pathname).toMatch(/\/login$/);
    });
  });
});
