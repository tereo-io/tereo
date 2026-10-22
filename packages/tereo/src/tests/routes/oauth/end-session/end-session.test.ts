// @module-tag int
// @module-tag auth
import { DEFAULT_ORGANIZATION_ID } from "../../../../definitions/index.js";
import { hashFlowToken, hashPassword } from "../../../../utils/crypto.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "../../../support/auth/users.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
} from "../../../support/auth/constants.js";
import {
  absorbCookies,
  browserLogin,
  confirmLogout,
  cookieHeader,
  userSessionCookieName,
  type CookieJar,
} from "../../../support/browserLogin.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../support/webhooks.js";

describe("/oauth/end-session and /oauth/end-session/confirm", () => {
  /**
   * End-session without an id_token_hint: anything can send a browser there,
   * so it only asks the user to confirm. The session ends on the confirm POST,
   * and only with the token core put in this browser's cookie.
   */

  const REDIRECT_URI = "http://localhost:3000/end-session-confirm-callback";
  const POST_LOGOUT_URI = "http://localhost:3000/end-session-confirm-logout";
  const CONFIRM_COOKIE = "tereo_logout_confirm";

  let client: Awaited<ReturnType<typeof createTestClient>>;

  const signIn = async () => {
    const user = await createTestUser();
    const { jar } = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid",
      email: user.email,
      password: user.plainPassword,
    });
    return { user, jar };
  };

  const sessionsOf = (userId: string) =>
    prisma.userSession.count({ where: { userId } });

  /** A cross-site GET: the browser's cookies, no hint. */
  const endSessionGet = (jar: CookieJar, params: Record<string, string>) =>
    fetch(`${BASE_URL}/oauth/end-session?${new URLSearchParams(params)}`, {
      redirect: "manual",
      headers: { Cookie: cookieHeader(jar) },
    });

  const postConfirm = (jar: CookieJar, body: Record<string, string>) =>
    fetch(`${BASE_URL}/oauth/end-session/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    client = await createTestClient({
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [POST_LOGOUT_URI],
    });
  });

  describe("end-session without id_token_hint", () => {
    it("does not end the session on a GET; it sends the browser to confirm", async () => {
      const { user, jar } = await signIn();
      const ssoCookie = jar.get(userSessionCookieName(client.clientId));

      const res = await endSessionGet(jar, { client_id: client.clientId });
      expect(res.status).toBe(302);
      const page = new URL(res.headers.get("location") ?? "");
      expect(page.pathname).toMatch(/\/logout$/);
      expect(page.searchParams.get("client_id")).toBe(client.clientId);

      // Nothing ended and no session cookie cleared: only the confirm cookie set.
      expect(await sessionsOf(user.id)).toBe(1);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toHaveLength(1);
      expect(setCookies[0]).toMatch(
        new RegExp(`^${CONFIRM_COOKIE}_${client.clientId}=`)
      );
      absorbCookies(jar, res);
      expect(jar.get(userSessionCookieName(client.clientId))).toBe(ssoCookie);
    });

    it("does not end the session on a POST either", async () => {
      const { user, jar } = await signIn();

      const res = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader(jar),
        },
        body: new URLSearchParams({ client_id: client.clientId }),
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(await sessionsOf(user.id)).toBe(1);
    });

    it("ends this browser's session once the user confirms", async () => {
      const { user, jar } = await signIn();
      const other = await browserLogin({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid",
        email: user.email,
        password: user.plainPassword,
      });
      expect(await sessionsOf(user.id)).toBe(2);

      const res = await confirmLogout(
        jar,
        await endSessionGet(jar, {
          client_id: client.clientId,
          post_logout_redirect_uri: POST_LOGOUT_URI,
          state: "bye",
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        redirect_url: string;
        sign_in_url: string;
      };
      expect(body.redirect_url).toBe(`${POST_LOGOUT_URI}?state=bye`);
      expect(body.sign_in_url).toBe("http://localhost:3000/");

      expect(jar.has(userSessionCookieName(client.clientId))).toBe(false);
      expect(jar.has(`${CONFIRM_COOKIE}_${client.clientId}`)).toBe(false);
      // The other browser's session survives.
      const remaining = await prisma.userSession.findMany({
        where: { userId: user.id },
      });
      expect(remaining.map((s) => s.tokenHash)).toEqual([
        hashFlowToken(other.jar.get(userSessionCookieName(client.clientId))!),
      ]);
    });

    it("shows the confirm page the client's name, given the browser's token", async () => {
      const { jar } = await signIn();
      const res = await endSessionGet(jar, { client_id: client.clientId });
      absorbCookies(jar, res);
      const page = new URL(res.headers.get("location") ?? "");

      const details = await fetch(
        `${BASE_URL}/oauth/end-session/confirm?${new URLSearchParams({
          client_id: client.clientId,
          confirm_token: page.searchParams.get("confirm_token")!,
        })}`,
        { headers: { Cookie: cookieHeader(jar) } }
      );
      expect(details.status).toBe(200);
      expect(await details.json()).toEqual({
        client_name: client.name,
        sign_in_url: "http://localhost:3000/",
      });
    });

    it("refuses a confirm without the cookie's token", async () => {
      const { user, jar } = await signIn();
      const res = await endSessionGet(jar, { client_id: client.clientId });
      absorbCookies(jar, res);
      const token = new URL(res.headers.get("location") ?? "").searchParams.get(
        "confirm_token"
      )!;

      // A wrong token, with the cookie.
      const wrong = await postConfirm(jar, {
        client_id: client.clientId,
        confirm_token: `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`,
      });
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as { error: string }).error).toBe(
        "invalid_session"
      );

      // The right token, from a browser that was never given the cookie: what
      // a cross-site form post that learned the URL would look like.
      const withoutCookie = new Map(jar);
      withoutCookie.delete(`${CONFIRM_COOKIE}_${client.clientId}`);
      const stolen = await postConfirm(withoutCookie, {
        client_id: client.clientId,
        confirm_token: token,
      });
      expect(stolen.status).toBe(400);

      // The details lookup is refused the same way.
      const details = await fetch(
        `${BASE_URL}/oauth/end-session/confirm?${new URLSearchParams({
          client_id: client.clientId,
          confirm_token: "not-the-token",
        })}`,
        { headers: { Cookie: cookieHeader(jar) } }
      );
      expect(details.status).toBe(400);

      expect(await sessionsOf(user.id)).toBe(1);
    });

    it("accepts a confirm token only once", async () => {
      const { jar } = await signIn();
      const res = await endSessionGet(jar, { client_id: client.clientId });
      const token = new URL(res.headers.get("location") ?? "").searchParams.get(
        "confirm_token"
      )!;
      const first = await confirmLogout(jar, res);
      expect(first.status).toBe(200);

      const again = await postConfirm(jar, {
        client_id: client.clientId,
        confirm_token: token,
      });
      expect(again.status).toBe(400);
    });

    it("refuses an unregistered post_logout_redirect_uri at confirm", async () => {
      const { user, jar } = await signIn();
      const res = await endSessionGet(jar, { client_id: client.clientId });
      absorbCookies(jar, res);
      const token = new URL(res.headers.get("location") ?? "").searchParams.get(
        "confirm_token"
      )!;

      const confirm = await postConfirm(jar, {
        client_id: client.clientId,
        confirm_token: token,
        post_logout_redirect_uri: "https://evil.example/landing",
      });
      expect(confirm.status).toBe(400);
      expect(await sessionsOf(user.id)).toBe(1);
    });

    it("still ends the session at once with a valid id_token_hint", async () => {
      const user = await createTestUser();
      const { jar, code, verifier } = await browserLogin({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid",
        email: user.email,
        password: user.plainPassword,
      });
      const tokens = await fetch(`${BASE_URL}/oauth/token`, {
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
      const { id_token } = (await tokens.json()) as { id_token: string };

      const res = await endSessionGet(jar, {
        id_token_hint: id_token,
        post_logout_redirect_uri: POST_LOGOUT_URI,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(POST_LOGOUT_URI);
      expect(await sessionsOf(user.id)).toBe(0);
    });

    it("asks to confirm when the hint names someone other than the browser's user", async () => {
      // Any site can sign its own user in and hold their ID token for the
      // client; sent with a victim's browser, it must not sign the victim out.
      const { user: victim, jar } = await signIn();
      const ssoCookie = jar.get(userSessionCookieName(client.clientId));
      const attacker = await createTestUser();
      const login = await browserLogin({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid",
        email: attacker.email,
        password: attacker.plainPassword,
      });
      const tokens = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          code: login.code,
          redirect_uri: REDIRECT_URI,
          code_verifier: login.verifier,
        }),
      });
      const { id_token } = (await tokens.json()) as { id_token: string };

      const res = await endSessionGet(jar, {
        id_token_hint: id_token,
        post_logout_redirect_uri: POST_LOGOUT_URI,
      });
      expect(res.status).toBe(302);
      const page = new URL(res.headers.get("location") ?? "");
      expect(page.pathname).toMatch(/\/logout$/);
      expect(page.searchParams.get("confirm_token")).toBeTruthy();

      // Nothing ended, and only the confirm cookie set.
      expect(await sessionsOf(victim.id)).toBe(1);
      expect(await sessionsOf(attacker.id)).toBe(1);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toHaveLength(1);
      expect(setCookies[0]).toMatch(
        new RegExp(`^${CONFIRM_COOKIE}_${client.clientId}=`)
      );
      absorbCookies(jar, res);
      expect(jar.get(userSessionCookieName(client.clientId))).toBe(ssoCookie);

      // The victim can still sign out by confirming.
      const confirmed = await confirmLogout(jar, res);
      expect(confirmed.status).toBe(200);
      expect(await sessionsOf(victim.id)).toBe(0);
    });
  });
});

describe("/oauth/end-session and /oauth/end-session/confirm", () => {
  const REDIRECT_URI = "http://localhost:3000/token-lifecycle-audit-callback";
  const SCOPE = "openid offline_access";

  type TestUser = Awaited<ReturnType<typeof createTestUser>>;

  let client: Awaited<ReturnType<typeof createTestClient>>;
  let endpointId: string;

  beforeAll(async () => {
    client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.sessions-revoked"] }
    );
    endpointId = endpoint.id;
  });

  const exchange = (code: string, verifier: string) =>
    fetch(`${BASE_URL}/oauth/token`, {
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

  interface Tokens {
    access_token: string;
    refresh_token: string;
    id_token: string;
  }

  const signIn = async (user?: TestUser, jar?: CookieJar) => {
    const u = user ?? (await createTestUser());
    const login = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      email: u.email,
      password: u.plainPassword,
      jar,
    });
    const res = await exchange(login.code, login.verifier);
    expect(res.status).toBe(HTTP_STATUS.OK);
    return {
      user: u,
      jar: login.jar,
      code: login.code,
      verifier: login.verifier,
      tokens: (await res.json()) as Tokens,
    };
  };

  const entriesOf = (userId: string) =>
    prisma.auditLogEntry.findMany({
      where: { entityType: "User", entityId: userId },
      orderBy: { createdAt: "asc" },
    });

  const revokedEventsFor = (userId: string) =>
    prisma.webhookDelivery.count({
      where: {
        webhookEndpointId: endpointId,
        eventType: "auth.user.sessions-revoked",
        payload: { path: ["entityId"], equals: userId },
      },
    });

  const expectRevokedEvent = (userId: string) =>
    waitFor(async () => (await revokedEventsFor(userId)) > 0, 10_000);

  describe("POST /oauth/end-session", () => {
    const endSession = (jar: CookieJar, idTokenHint: string) =>
      fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader(jar),
        },
        body: new URLSearchParams({ id_token_hint: idTokenHint }),
      });

    it("emits the revocation beside LOGOUT, and records nothing when already signed out", async () => {
      const { user, jar, tokens } = await signIn();

      expect((await endSession(jar, tokens.id_token)).status).toBe(
        HTTP_STATUS.OK
      );
      expect(
        (await entriesOf(user.id)).filter((e) => e.action === "LOGOUT")
      ).toHaveLength(1);
      await expectRevokedEvent(user.id);
      const events = await revokedEventsFor(user.id);

      // The same hint again, the session it names already ended.
      expect((await endSession(new Map(), tokens.id_token)).status).toBe(
        HTTP_STATUS.OK
      );
      expect(
        (await entriesOf(user.id)).filter((e) => e.action === "LOGOUT")
      ).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await revokedEventsFor(user.id)).toBe(events);
    });
  });
});

describe("/oauth/end-session and /oauth/end-session/confirm", () => {
  // Test entity variables
  let TEST_CLIENT_ID = "";
  let TEST_CLIENT_DB_ID = "";
  const TEST_REDIRECT_URI = "http://localhost:3000/test-callback";
  const TEST_POST_LOGOUT_URI = "http://localhost:3000/test-logout";

  interface EndSessionResponse {
    success?: boolean;
    error?: string;
    error_description?: string;
  }

  describe("OIDC Compliance", () => {
    beforeAll(async () => {
      // Check server is running
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      if (!response.ok) {
        throw new Error(`Server not running at ${BASE_URL}`);
      }

      // Create test entities
      const uniqueId = randomBytes(8).toString("hex");
      TEST_CLIENT_ID = `test-oidc-client-${uniqueId}`;

      // Create test owner user
      const ownerPasswordHash = await hashPassword("TestPassword123!");
      const testOwner = await prisma.user.create({
        data: {
          email: `test-oidc-owner-${uniqueId}@test.local`,
          passwordHash: ownerPasswordHash,
          name: "OIDC Test Owner",
          isActive: true,
        },
      });

      const client = await prisma.oAuthClient.create({
        data: {
          clientId: TEST_CLIENT_ID,
          clientSecret: null,
          clientType: "public",
          name: `OIDC Test Client ${uniqueId}`,
          redirectUris: [TEST_REDIRECT_URI],
          postLogoutRedirectUris: [TEST_POST_LOGOUT_URI],
          scopes: ["openid", "profile", "email", "offline_access"],
          grantTypes: ["authorization_code", "refresh_token"],
          audience: [],
          ownerId: testOwner.id,
        },
      });
      TEST_CLIENT_DB_ID = client.id;
    });

    afterAll(async () => {
      // Cleanup test entities
      if (TEST_CLIENT_DB_ID) {
        await prisma.oAuthClient
          .delete({ where: { id: TEST_CLIENT_DB_ID } })
          .catch(() => {});
      }
    });

    describe("End Session Endpoint", () => {
      it("should reject GET without client_id or id_token_hint", async () => {
        const response = await fetch(`${BASE_URL}/oauth/end-session`);
        const data = (await response.json()) as EndSessionResponse;

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should reject POST without client_id or id_token_hint", async () => {
        const response = await fetch(`${BASE_URL}/oauth/end-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = (await response.json()) as EndSessionResponse;

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      /** The UI's sign-out confirmation page end-session sent the browser to. */
      const confirmPage = (response: Response) => {
        expect(response.status).toBe(HTTP_STATUS.FOUND);
        const location = new URL(response.headers.get("location") || "");
        expect(location.pathname).toMatch(/\/logout$/);
        expect(location.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
        expect(location.searchParams.get("confirm_token")).toBeTruthy();
        return location;
      };

      it("sends a POST without id_token_hint to the confirmation page", async () => {
        const response = await fetch(`${BASE_URL}/oauth/end-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: TEST_CLIENT_ID,
            state: "test-state-from-body",
          }),
          redirect: "manual",
        });

        const page = confirmPage(response);
        expect(page.searchParams.get("state")).toBe("test-state-from-body");
      });

      it("carries post_logout_redirect_uri from a POST to the confirmation page", async () => {
        const response = await fetch(`${BASE_URL}/oauth/end-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: TEST_CLIENT_ID,
            post_logout_redirect_uri: TEST_POST_LOGOUT_URI,
            state: "post-body-state",
          }),
          redirect: "manual",
        });

        const page = confirmPage(response);
        expect(page.searchParams.get("post_logout_redirect_uri")).toBe(
          TEST_POST_LOGOUT_URI
        );
        expect(page.searchParams.get("state")).toBe("post-body-state");
      });

      it("should reject unregistered post_logout_redirect_uri", async () => {
        const response = await fetch(
          `${BASE_URL}/oauth/end-session?post_logout_redirect_uri=https://evil.com/callback&client_id=${TEST_CLIENT_ID}`,
          { redirect: "manual" }
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as EndSessionResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
        expect(data.error_description).toBe(
          "post_logout_redirect_uri is not registered for this client"
        );
      });

      it("carries a valid post_logout_redirect_uri and state from a GET to the confirmation page", async () => {
        const response = await fetch(
          `${BASE_URL}/oauth/end-session?post_logout_redirect_uri=${encodeURIComponent(
            TEST_POST_LOGOUT_URI
          )}&client_id=${TEST_CLIENT_ID}&state=my-state-value`,
          { redirect: "manual" }
        );

        const page = confirmPage(response);
        expect(page.searchParams.get("post_logout_redirect_uri")).toBe(
          TEST_POST_LOGOUT_URI
        );
        expect(page.searchParams.get("state")).toBe("my-state-value");
      });
    });

    describe("End Session - id_token_hint parameter", () => {
      it("should reject invalid id_token_hint with appropriate error", async () => {
        // Invalid id_token_hint should be rejected per OIDC RP-Initiated Logout spec
        const response = await fetch(
          `${BASE_URL}/oauth/end-session?id_token_hint=eyJhbGciOiJSUzI1NiJ9.test&client_id=${TEST_CLIENT_ID}`,
          { redirect: "manual" }
        );

        // Invalid JWT must be rejected with 400
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const data = (await response.json()) as { error: string };
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should reject invalid id_token_hint with post_logout_redirect_uri", async () => {
        const response = await fetch(
          `${BASE_URL}/oauth/end-session?id_token_hint=test-token&post_logout_redirect_uri=${encodeURIComponent(
            TEST_POST_LOGOUT_URI
          )}&client_id=${TEST_CLIENT_ID}`,
          { redirect: "manual" }
        );

        // Invalid id_token_hint must be rejected even with valid post_logout_redirect_uri
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const data = (await response.json()) as { error: string };
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });
    });
  });
});

describe("/oauth/end-session and /oauth/end-session/confirm", () => {
  describe("Redirect URI schemes", () => {
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
      const data = (await res.json()) as {
        error?: string;
        error_description?: string;
      };
      expect(data.error).toBe("invalid_request");
      expect(data.error_description).toEqual(expect.any(String));
    });
  });
});
