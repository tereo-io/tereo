// @module-tag int
// @module-tag auth
import { browserLogin, type CookieJar } from "../../../support/browserLogin.js";
import { DEFAULT_ORGANIZATION_ID } from "../../../../definitions/index.js";
import { TokenResponse, decodeJwt } from "../../../support/auth/tokens.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { createTestUser } from "../../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import jwt from "jsonwebtoken";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
} from "../../../support/auth/constants.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../../support/auth/crypto.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../support/webhooks.js";

describe("POST /oauth/revoke", () => {
  interface AuthorizeResponse {
    redirect_url?: string;
    error?: string;
    error_description?: string;
  }

  interface ConsentResponse {
    redirect_url?: string;
    error?: string;
    error_description?: string;
  }

  describe("OAuth Revoke Endpoint", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser();
    });

    // Helper to get tokens
    async function getTokens(): Promise<TokenResponse> {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();
      const redirectUri = testClient.redirectUris[0];

      // Step 1: GET to get session cookie
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid offline_access");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const getResponse = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      const setCookieHeader = getResponse.headers.get("set-cookie") || "";
      const sessionCookieMatch = setCookieHeader.match(
        /tereo_session_[^=]+=([^;]+)/
      );
      const sessionCookie = sessionCookieMatch ? sessionCookieMatch[0] : "";

      // Step 2: POST credentials
      const authResponse = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          response_type: "code",
          client_id: testClient.clientId,
          redirect_uri: redirectUri,
          state,
          scope: "openid offline_access",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const authData = (await authResponse.json()) as AuthorizeResponse;

      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");

      expect(sessionId).toBeTruthy();
      const authCookieHeader = authResponse.headers.get("set-cookie") || "";
      const consentCookieMatch = authCookieHeader.match(
        /tereo_consent_session_[^=]+=([^;]+)/
      );
      const consentCookie = consentCookieMatch ? consentCookieMatch[0] : "";

      const consentResponse = await fetch(`${BASE_URL}/oauth/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: consentCookie,
        },
        body: JSON.stringify({ session_token: sessionId, approved: true }),
        redirect: "manual",
      });

      const consentData = (await consentResponse.json()) as ConsentResponse;
      expect(consentData.redirect_url).toContain("code=");
      const code = new URL(consentData.redirect_url!).searchParams.get("code");

      const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      return (await tokenResponse.json()) as TokenResponse;
    }

    describe("POST /oauth/revoke", () => {
      it("should revoke access token and return 200 per RFC 7009", async () => {
        const tokens = await getTokens();
        expect(tokens.access_token).toBeDefined();

        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.access_token,
            client_id: testClient.clientId,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.OK);

        // Verify token is revoked by trying to use it
        const userinfoResponse = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });

        expect(userinfoResponse.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });

      it("should revoke refresh token and return 200 per RFC 7009", async () => {
        const tokens = await getTokens();
        expect(tokens.refresh_token).toBeDefined();

        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.refresh_token,
            client_id: testClient.clientId,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.OK);

        // Verify refresh token is revoked by trying to use it
        const refreshResponse = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            client_id: testClient.clientId,
          }),
        });

        expect(refreshResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const refreshData = (await refreshResponse.json()) as TokenResponse;
        expect(refreshData.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
      });

      it("should accept token_type_hint=access_token and return 200", async () => {
        const tokens = await getTokens();

        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.access_token,
            token_type_hint: "access_token",
            client_id: testClient.clientId,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
      });

      it("should accept token_type_hint=refresh_token and return 200", async () => {
        const tokens = await getTokens();

        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.refresh_token,
            token_type_hint: "refresh_token",
            client_id: testClient.clientId,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
      });

      it("should return 200 for unknown token per RFC 7009 Section 2.2", async () => {
        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "unknown-token-that-does-not-exist",
            client_id: testClient.clientId,
          }),
        });

        // RFC 7009 Section 2.2: Server MUST respond with 200 OK even for unknown tokens
        // to prevent token scanning attacks
        expect(response.status).toBe(HTTP_STATUS.OK);
      });

      it("should return 401 invalid_client for an unknown client", async () => {
        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "some-token",
            client_id: "unknown-client",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        const data = (await response.json()) as { error?: string };
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
      });

      it("should return 400 invalid_request with neither a token nor a refresh cookie", async () => {
        // RFC 7009 section 2.1: token is required.
        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: testClient.clientId,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const data = (await response.json()) as { error?: string };
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should take the refresh cookie in place of a token", async () => {
        const tokens = await getTokens();
        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `trt_${testClient.clientId}=${tokens.refresh_token}`,
          },
          body: JSON.stringify({ client_id: testClient.clientId }),
        });
        expect(response.status).toBe(HTTP_STATUS.OK);

        const refresh = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            client_id: testClient.clientId,
          }),
        });
        expect(refresh.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("should return 200 for another client's token, and leave it", async () => {
        const tokens = await getTokens();
        const otherClient = await createTestClient();
        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.access_token,
            client_id: otherClient.clientId,
          }),
        });
        expect(response.status).toBe(HTTP_STATUS.OK);

        const userinfo = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        expect(userinfo.status).toBe(HTTP_STATUS.OK);
      });

      it("should cascade revoke access tokens when refresh token is revoked (security feature)", async () => {
        const tokens = await getTokens();
        expect(tokens.refresh_token).toBeDefined();
        expect(tokens.access_token).toBeDefined();

        // Revoke the refresh token
        const revokeResponse = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.refresh_token,
            token_type_hint: "refresh_token",
            client_id: testClient.clientId,
          }),
        });

        expect(revokeResponse.status).toBe(HTTP_STATUS.OK);

        // Verify access token is also revoked (cascade revocation for security)
        const userinfoResponse = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });

        expect(userinfoResponse.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });

      it("should return 400 for an empty token value, as for a missing one", async () => {
        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: "",
            client_id: testClient.clientId,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("should return 200 for already revoked token per RFC 7009 (idempotent)", async () => {
        const tokens = await getTokens();

        // First revocation
        const firstRevoke = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.access_token,
            client_id: testClient.clientId,
          }),
        });
        expect(firstRevoke.status).toBe(HTTP_STATUS.OK);

        // Second revocation of same token - should still succeed (idempotent)
        const secondRevoke = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.access_token,
            client_id: testClient.clientId,
          }),
        });
        expect(secondRevoke.status).toBe(HTTP_STATUS.OK);
      });

      it("should properly revoke token issued by a specific client", async () => {
        const tokens = await getTokens();

        // Revoke with correct client_id
        const response = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.access_token,
            client_id: testClient.clientId,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.OK);

        const userinfo = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        expect(userinfo.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });
    });
  });
});

describe("POST /oauth/revoke", () => {
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
  let ccClient: Client;

  beforeAll(async () => {
    ccClient = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
  });

  describe("Introspection and revocation", () => {
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
});

describe("POST /oauth/revoke", () => {
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

  const revoke = (token: string) =>
    fetch(`${BASE_URL}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: client.clientId }),
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

  const sidOf = (accessToken: string) =>
    (decodeJwt(accessToken) as unknown as { sid: string }).sid;

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

  it("audits a refresh-token revoke as a LOGOUT and emits it, once", async () => {
    const { user, tokens } = await signIn();
    const sid = sidOf(tokens.access_token);

    expect((await revoke(tokens.refresh_token)).status).toBe(HTTP_STATUS.OK);

    const logouts = (await entriesOf(user.id)).filter(
      (e) => e.action === "LOGOUT"
    );
    expect(logouts).toHaveLength(1);
    expect(logouts[0]).toMatchObject({ userId: user.id });
    expect(logouts[0].metadata).toMatchObject({
      action: "sessions_revoked",
      method: "revoke",
      sessionIds: [sid],
    });
    await expectRevokedEvent(user.id);

    // Nothing left to revoke: nothing more recorded.
    expect((await revoke(tokens.refresh_token)).status).toBe(HTTP_STATUS.OK);
    expect(
      (await entriesOf(user.id)).filter((e) => e.action === "LOGOUT")
    ).toHaveLength(1);
  });

  it("audits an access-token revoke in its transaction, once", async () => {
    const { user, tokens } = await signIn();
    const { jti } = decodeJwt(tokens.access_token) as unknown as {
      jti: string;
    };

    expect((await revoke(tokens.access_token)).status).toBe(HTTP_STATUS.OK);
    expect(
      (await prisma.accessToken.findUniqueOrThrow({ where: { jti } })).revokedAt
    ).not.toBeNull();
    const logouts = (await entriesOf(user.id)).filter(
      (e) => e.action === "LOGOUT"
    );
    expect(logouts).toHaveLength(1);
    expect(logouts[0].metadata).toEqual({
      action: "token_revoked",
      method: "revoke",
      tokenType: "access_token",
      jti,
      clientId: client.clientId,
    });

    expect((await revoke(tokens.access_token)).status).toBe(HTTP_STATUS.OK);
    expect(
      (await entriesOf(user.id)).filter((e) => e.action === "LOGOUT")
    ).toHaveLength(1);
  });
});
