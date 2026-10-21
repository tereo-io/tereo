import { expectAuthorizeErrorRedirect } from "./utils/authorizeErrors.js";
import { hashAuthorizationCode } from "../../utils/crypto.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
  createTestClient,
  createTestUser,
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
  TokenResponse,
  decodeJwt,
} from "./utils/test-helpers.js";

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

describe("OAuth Security Tests", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let confidentialClient: Awaited<ReturnType<typeof createTestClient>>;
  let testUser: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    testClient = await createTestClient();
    // Create confidential client with client_credentials grant for security tests
    confidentialClient = await createTestClient({
      clientType: "confidential",
      grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
    });
    testUser = await createTestUser();
  });

  // Helper to get authorization code
  async function getAuthorizationCode(
    client: typeof testClient,
    codeChallenge: string,
    scope: string = "openid profile email offline_access"
  ): Promise<{ code: string | null; cookies: string }> {
    const state = generateUniqueId();
    const redirectUri = client.redirectUris[0];

    const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("scope", scope);
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

    expect(sessionCookie).toBeTruthy();

    const response = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: redirectUri,
        state,
        scope,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        email: testUser.email,
        password: testUser.plainPassword,
      }),
      redirect: "manual",
    });

    const authData = (await response.json()) as AuthorizeResponse;
    const authCookies = response.headers.get("set-cookie") || "";

    expect(authData.redirect_url).toContain("/consent");
    const consentUrl = new URL(authData.redirect_url!);
    const sessionId = consentUrl.searchParams.get("session");

    expect(sessionId).toBeTruthy();
    const consentCookieMatch = authCookies.match(
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
    const url = new URL(consentData.redirect_url!);
    return { code: url.searchParams.get("code"), cookies: authCookies };
  }

  describe("PKCE Security", () => {
    it("should reject authorization code exchange without code_verifier for public client", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const { code } = await getAuthorizationCode(testClient, codeChallenge);
      expect(code).toBeTruthy();

      // Try to exchange code without code_verifier
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          // Intentionally omitting code_verifier
        }),
      });

      const data = (await response.json()) as TokenResponse;

      // RFC 7636 Section 4.6: Missing code_verifier with PKCE must return invalid_grant
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
    });

    it("should reject authorization code exchange with wrong code_verifier", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const { code } = await getAuthorizationCode(testClient, codeChallenge);
      expect(code).toBeTruthy();

      // Try to exchange code with different code_verifier
      const wrongVerifier = generateCodeVerifier(); // Different verifier

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: wrongVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
    });

    it("should reject plain code_challenge_method (insecure)", async () => {
      const state = generateUniqueId();
      const codeVerifier = generateCodeVerifier();
      const redirectUri = testClient.redirectUris[0];

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeVerifier); // Plain verifier
      authorizeUrl.searchParams.set("code_challenge_method", "plain"); // Insecure method

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expectAuthorizeErrorRedirect(
        response,
        redirectUri,
        "invalid_request",
        state
      );
    });
  });

  describe("Authorization Code Security", () => {
    it("should reject reused authorization code", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const { code } = await getAuthorizationCode(testClient, codeChallenge);
      expect(code).toBeTruthy();

      // First exchange - should succeed
      const firstResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      expect(firstResponse.status).toBe(HTTP_STATUS.OK);

      // Second exchange with same code - should fail
      const secondResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const data = (await secondResponse.json()) as TokenResponse;

      expect(secondResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
    });

    it("should reject authorization code for different client", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Get code for testClient
      const { code } = await getAuthorizationCode(testClient, codeChallenge);
      expect(code).toBeTruthy();

      // Try to use code with different (confidential) client, providing valid auth
      const credentials = Buffer.from(
        `${confidentialClient.clientId}:${confidentialClient.plainSecret}`
      ).toString("base64");

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: confidentialClient.redirectUris[0],
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      // RFC 6749: Authorization code issued to another client = invalid_grant
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
    });

    it("should reject authorization code with wrong redirect_uri", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const { code } = await getAuthorizationCode(testClient, codeChallenge);
      expect(code).toBeTruthy();

      // Try to exchange with different redirect_uri
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://malicious-site.com/callback",
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
    });

    it("should reject expired authorization code per RFC 6749 Section 4.1.2", async () => {
      // RFC 6749: Authorization code MUST expire shortly after issuance (max 10 minutes)
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const { code } = await getAuthorizationCode(testClient, codeChallenge);
      expect(code).toBeTruthy();

      // Manually expire the authorization code in the database
      // This simulates waiting for the code to expire
      // Authorization codes are stored by their HMAC, never the raw code
      const { prisma } = await import("../../utils/db/prisma.js");
      const codeHash = hashAuthorizationCode(code!);

      await prisma.authorizationCode.updateMany({
        where: { codeHash },
        data: { expiresAt: new Date(Date.now() - 1000) }, // Set to 1 second in the past
      });

      // Try to exchange the expired code
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      // RFC 6749: Expired authorization code must return invalid_grant
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
    });
  });

  describe("Refresh Token Security", () => {
    it("should invalidate old refresh token after rotation", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const { code } = await getAuthorizationCode(testClient, codeChallenge);
      expect(code).toBeTruthy();

      // Get initial tokens
      const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const tokens = (await tokenResponse.json()) as TokenResponse;
      expect(tokens.refresh_token).toBeDefined();

      const originalRefreshToken = tokens.refresh_token;

      // Use refresh token to get new tokens
      const refreshResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: originalRefreshToken,
          client_id: testClient.clientId,
        }),
      });

      expect(refreshResponse.status).toBe(HTTP_STATUS.OK);

      const newTokens = (await refreshResponse.json()) as TokenResponse;
      expect(newTokens.refresh_token).toBeDefined();
      expect(newTokens.refresh_token).not.toBe(originalRefreshToken);

      // Try to use original refresh token again - should fail (rotation)
      const replayResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: originalRefreshToken,
          client_id: testClient.clientId,
        }),
      });

      const replayData = (await replayResponse.json()) as TokenResponse;

      expect(replayResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(replayData.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
    });

    /** A fresh token family for testClient: its first tokens. */
    const startFamily = async (): Promise<TokenResponse> => {
      const codeVerifier = generateCodeVerifier();
      const { code } = await getAuthorizationCode(
        testClient,
        generateCodeChallenge(codeVerifier)
      );
      const res = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      return (await res.json()) as TokenResponse;
    };

    const refresh = (refreshToken: string) =>
      fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: testClient.clientId,
        }),
      });

    const jtiOf = (accessToken: string) =>
      (decodeJwt(accessToken) as unknown as { jti: string }).jti;

    const refreshRow = (jti: string) =>
      prisma.accessToken.findUniqueOrThrow({ where: { jti } }).then((at) =>
        prisma.refreshToken.findUniqueOrThrow({
          where: { id: at.refreshTokenId! },
        })
      );

    const accessRevokedAt = async (accessToken: string) =>
      (
        await prisma.accessToken.findUniqueOrThrow({
          where: { jti: jtiOf(accessToken) },
        })
      ).revokedAt;

    it("refuses a replay just after rotation without ending the family", async () => {
      const first = await startFamily();
      const rotated = await refresh(first.refresh_token!);
      expect(rotated.status).toBe(HTTP_STATUS.OK);
      const second = (await rotated.json()) as TokenResponse;

      const replay = await refresh(first.refresh_token!);
      expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(((await replay.json()) as TokenResponse).error).toBe(
        OAUTH_ERRORS.INVALID_GRANT
      );

      // The successor the first refresh received still works.
      expect(await accessRevokedAt(second.access_token!)).toBeNull();
      const next = await refresh(second.refresh_token!);
      expect(next.status).toBe(HTTP_STATUS.OK);
    });

    it("revokes the family when a token is replayed after the grace period", async () => {
      const first = await startFamily();
      const rotated = await refresh(first.refresh_token!);
      const second = (await rotated.json()) as TokenResponse;

      const old = await refreshRow(jtiOf(first.access_token!));
      expect(old.rotatedAt).not.toBeNull();
      await prisma.refreshToken.update({
        where: { id: old.id },
        data: { rotatedAt: new Date(Date.now() - 60_000) },
      });

      const replay = await refresh(first.refresh_token!);
      expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);

      expect(await accessRevokedAt(second.access_token!)).not.toBeNull();
      const next = await refresh(second.refresh_token!);
      expect(next.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("revokes the family when a token is replayed within the grace after its successor was spent", async () => {
      const first = await startFamily();
      const second = (await (
        await refresh(first.refresh_token!)
      ).json()) as TokenResponse;
      // The thief's chain moves on: the successor is spent too.
      const thirdRes = await refresh(second.refresh_token!);
      expect(thirdRes.status).toBe(HTTP_STATUS.OK);
      const third = (await thirdRes.json()) as TokenResponse;

      // The victim replays the first token, still inside the grace.
      const replay = await refresh(first.refresh_token!);
      expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);

      expect(await accessRevokedAt(third.access_token!)).not.toBeNull();
      const next = await refresh(third.refresh_token!);
      expect(next.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("treats a token revoked at logout as invalid, not as reuse", async () => {
      const first = await startFamily();
      const rotated = await refresh(first.refresh_token!);
      const second = (await rotated.json()) as TokenResponse;

      const revoke = await fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: second.refresh_token,
          client_id: testClient.clientId,
        }),
      });
      expect(revoke.status).toBe(HTTP_STATUS.OK);
      const revokedRow = await refreshRow(jtiOf(second.access_token!));
      expect(revokedRow.revokedAt).not.toBeNull();
      expect(revokedRow.rotatedAt).toBeNull();

      const firstAccessBefore = await accessRevokedAt(first.access_token!);
      const replay = await refresh(second.refresh_token!);
      expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(((await replay.json()) as TokenResponse).error).toBe(
        OAUTH_ERRORS.INVALID_GRANT
      );
      // No family revocation ran: the family's other access token is as the
      // revoke left it.
      expect(await accessRevokedAt(first.access_token!)).toEqual(
        firstAccessBefore
      );
    });

    it("does not call a token revoked on its own reuse", async () => {
      const first = await startFamily();
      const rotated = await refresh(first.refresh_token!);
      const second = (await rotated.json()) as TokenResponse;

      // A single token ended by an admin, outside any rotation.
      const row = await refreshRow(jtiOf(second.access_token!));
      await prisma.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      });

      const replay = await refresh(second.refresh_token!);
      expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
      // Reuse handling would have revoked the family's live access tokens.
      expect(await accessRevokedAt(first.access_token!)).toBeNull();
      expect(await accessRevokedAt(second.access_token!)).toBeNull();
    });
  });

  describe("ID Token Security", () => {
    it("should include required OIDC claims in ID token", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const { code } = await getAuthorizationCode(
        testClient,
        codeChallenge,
        "openid profile email"
      );
      expect(code).toBeTruthy();

      const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const tokens = (await tokenResponse.json()) as TokenResponse;
      expect(tokens.id_token).toBeDefined();

      // Decode and validate ID token claims
      const claims = decodeJwt(tokens.id_token!);

      // Required claims per OIDC Core 1.0
      expect(claims.iss).toBeDefined();
      expect(claims.sub).toBeDefined();
      expect(claims.aud).toBeDefined();
      expect(claims.exp).toBeDefined();
      expect(claims.iat).toBeDefined();

      // Validate types
      expect(typeof claims.iss).toBe("string");
      expect(typeof claims.sub).toBe("string");
      expect(typeof claims.exp).toBe("number");
      expect(typeof claims.iat).toBe("number");

      // Validate audience contains client_id
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      expect(audiences).toContain(testClient.clientId);

      // Validate not expired
      const now = Math.floor(Date.now() / 1000);
      expect(claims.exp).toBeGreaterThan(now);

      // Validate iat is in the past (with small tolerance)
      expect(claims.iat).toBeLessThanOrEqual(now + 10);
    });

    it("should include nonce in ID token when provided in authorization request", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const nonce = generateUniqueId();
      const state = generateUniqueId();
      const redirectUri = testClient.redirectUris[0];

      // Make authorization request with nonce
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid profile");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("nonce", nonce);

      const getResponse = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      const setCookieHeader = getResponse.headers.get("set-cookie") || "";
      const sessionCookieMatch = setCookieHeader.match(
        /tereo_session_[^=]+=([^;]+)/
      );
      const sessionCookie = sessionCookieMatch ? sessionCookieMatch[0] : "";

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
          scope: "openid profile",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          nonce,
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const authData = (await authResponse.json()) as AuthorizeResponse;

      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");
      const authCookies = authResponse.headers.get("set-cookie") || "";
      const consentCookieMatch = authCookies.match(
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
      });

      const consentData = (await consentResponse.json()) as ConsentResponse;
      expect(consentData.redirect_url).toContain("code=");
      const code = new URL(consentData.redirect_url!).searchParams.get("code");

      expect(code).toBeTruthy();

      // Exchange code for tokens
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

      const tokens = (await tokenResponse.json()) as TokenResponse;
      expect(tokens.id_token).toBeDefined();

      // Verify nonce in ID token
      const claims = decodeJwt(tokens.id_token!);
      expect(claims.nonce).toBe(nonce);
    });
  });

  describe("Client Authentication Security", () => {
    it("should reject client_credentials grant for public client", async () => {
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: testClient.clientId,
          scope: "openid",
        }),
      });

      const data = (await response.json()) as TokenResponse;

      // RFC 6749 Section 5.2: unauthorized_client - the client is not authorized
      // to use this grant type (public clients cannot use client_credentials)
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.UNAUTHORIZED_CLIENT);
    });

    it("should accept client_credentials grant for confidential client with valid secret", async () => {
      const credentials = Buffer.from(
        `${confidentialClient.clientId}:${confidentialClient.plainSecret}`
      ).toString("base64");

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          scope: "openid",
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.access_token).toBeDefined();
      expect(data.token_type).toBe("Bearer");
      // Client credentials grant should NOT return refresh_token or id_token
      expect(data.refresh_token).toBeUndefined();
    });

    it("should reject confidential client with wrong secret", async () => {
      const credentials = Buffer.from(
        `${confidentialClient.clientId}:wrong-secret`
      ).toString("base64");

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          scope: "openid",
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
    });
  });

  describe("Redirect URI Security", () => {
    it("should reject authorization request with unregistered redirect_uri", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set(
        "redirect_uri",
        "http://malicious-site.com/callback"
      );
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      // Should return error, not redirect to malicious site
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("Scope Security", () => {
    it("should refuse scopes the client is not allowed", async () => {
      // Create a client with limited scopes
      const limitedClient = await createTestClient({
        scopes: ["openid", "profile"], // No email scope
      });

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();
      const redirectUri = limitedClient.redirectUris[0];

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", limitedClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid profile email"); // Requesting email
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const getResponse = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      // The login page is shown; scopes are checked once the user is known.
      expect(getResponse.status).toBe(302);
      const setCookieHeader = getResponse.headers.get("set-cookie") || "";
      const sessionCookieMatch = setCookieHeader.match(
        /tereo_session_[^=]+=([^;]+)/
      );
      expect(sessionCookieMatch).not.toBeNull();

      const authResponse = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookieMatch![0],
        },
        body: JSON.stringify({
          response_type: "code",
          client_id: limitedClient.clientId,
          redirect_uri: redirectUri,
          state,
          scope: "openid profile email",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      expect(authResponse.status).toBe(HTTP_STATUS.OK);
      const authData = (await authResponse.json()) as AuthorizeResponse;
      const redirect = new URL(authData.redirect_url!);
      expect(redirect.origin + redirect.pathname).toBe(redirectUri);
      expect(redirect.searchParams.get("error")).toBe("invalid_scope");
      expect(redirect.searchParams.get("error_description")).toContain("email");
      expect(redirect.searchParams.get("state")).toBe(state);
      expect(redirect.searchParams.has("code")).toBe(false);
    });
  });
});
