// @module-tag int
// @module-tag auth
import { createTestClient } from "../../support/auth/clients.js";
import { generateAccessToken } from "../../../utils/tokens.js";
import { makeServiceOf } from "../../support/testService.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { hashFlowToken } from "../../../utils/crypto.js";
import { decodeJwt } from "../../support/auth/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import env from "../../../env.js";
import {
  REDIRECT_URI,
  POST_LOGOUT_URI,
  SCOPE,
  sessionLifecycleHelpers,
  type Jar,
} from "../../support/auth/sessionLifecycle.js";

const USER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

let client: Awaited<ReturnType<typeof createTestClient>>;
let introspector: Awaited<ReturnType<typeof createTestClient>>;

const {
  absorb,
  cookieHeader,
  userSessionCookieName,
  newPkce,
  authorizeUrl,
  getAuthorize,
  createUser,
  approve,
  exchange,
  refresh,
  me,
  loginToCode,
  login,
  silentLogin,
} = sessionLifecycleHelpers(() => client);

const userSessionRows = (userId: string) =>
  prisma.userSession.findMany({ where: { userId } });

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

    const idleFor = (userId: string, seconds: number) =>
      prisma.userSession.updateMany({
        where: { userId },
        data: { lastUsedAt: new Date(Date.now() - seconds * 1000) },
      });

    it("forces a fresh login once the SSO session has been idle for USER_SESSION_IDLE_TTL", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await idleFor(user.id, env.USER_SESSION_IDLE_TTL + 1);

      const idle = jar.get(userSessionCookieName())!;
      expect((await silentLogin(jar)).loggedOut).toBe(true);
      jar.set(userSessionCookieName(), idle);
      expect((await silentLogin(jar, { org_id: user.orgId })).loggedOut).toBe(
        true
      );
    });

    it("keeps an SSO session in use alive, counting idleness from its last code", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      await idleFor(user.id, env.USER_SESSION_IDLE_TTL - 60);

      const result = await silentLogin(jar);
      expect(result.loggedOut).toBe(false);
      const [row] = await userSessionRows(user.id);
      expect(Date.now() - row.lastUsedAt.getTime()).toBeLessThan(60_000);
    });

    it("still logs out an idle SSO session, revoking what it issued", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      await idleFor(user.id, env.USER_SESSION_IDLE_TTL + 1);

      const url = new URL(`${BASE_URL}/oauth/end-session`);
      url.searchParams.set("id_token_hint", tokens.id_token!);
      url.searchParams.set("post_logout_redirect_uri", POST_LOGOUT_URI);
      const res = await fetch(url, {
        redirect: "manual",
        headers: { Cookie: cookieHeader(jar) },
      });
      expect(res.status).toBe(302);
      expect(await userSessionRows(user.id)).toHaveLength(0);
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
    });

    it("takes over an idle SSO session's row at the next password login", async () => {
      const user = await createUser();
      const { jar } = await login(user);
      const [before] = await userSessionRows(user.id);
      await idleFor(user.id, env.USER_SESSION_IDLE_TTL + 1);

      await login(user, jar);
      const rows = await userSessionRows(user.id);
      expect(rows.map((r) => r.id)).toEqual([before.id]);
      expect(rows[0].tokenHash).not.toBe(before.tokenHash);
      expect((await silentLogin(jar)).loggedOut).toBe(false);
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
      const rotated = await refresh(tokens.refresh_token);
      expect(rotated.status).toBe(200);
      expect((await me(tokens.access_token)).status).not.toBe(200);

      const introspect = async (token: string) => {
        const res = await fetch(`${BASE_URL}/oauth/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(
              `${introspector.clientId}:${introspector.plainSecret}`
            ).toString("base64")}`,
          },
          body: new URLSearchParams({ token }),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { active: boolean }).active;
      };
      expect(await introspect(tokens.access_token)).toBe(false);
      expect(await introspect(rotated.body.access_token!)).toBe(true);
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
