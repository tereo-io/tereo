// @module-tag int
// @module-tag auth
import { createTestClient } from "../../support/auth/clients.js";
import { confirmLogout } from "../../support/browserLogin.js";
import { makeServiceOf } from "../../support/testService.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { decodeJwt } from "../../support/auth/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  REDIRECT_URI,
  POST_LOGOUT_URI,
  sessionLifecycleHelpers,
  type Jar,
  type TokenSet,
  type TestUser,
  type Err,
} from "../../support/auth/sessionLifecycle.js";
import {
  ID_TOKEN_HINT_GRACE_SECONDS,
  generateIdToken,
} from "../../../utils/tokens.js";

let client: Awaited<ReturnType<typeof createTestClient>>;
let introspector: Awaited<ReturnType<typeof createTestClient>>;

const {
  absorb,
  cookieHeader,
  userSessionCookieName,
  createUser,
  refresh,
  me,
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

    it(
      "works after /oauth/revoke already revoked the refresh token (the UI's race)",
      { tags: ["race"] },
      async () => {
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
      }
    );

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
});
