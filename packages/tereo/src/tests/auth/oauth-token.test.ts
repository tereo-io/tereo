import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { createHash } from "node:crypto";
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
  verifyAtHash,
  getJwtHeader,
  verifyIdTokenSignature,
  fetchDiscoveryDocument,
  validateIdTokenClaims,
} from "./utils/test-helpers.js";

describe("OAuth Token Endpoint", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let testUser: Awaited<ReturnType<typeof createTestUser>>;
  let confidentialClient: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    testClient = await createTestClient();
    testUser = await createTestUser();
    confidentialClient = await createTestClient({ clientType: "confidential" });
  });

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

  // Helper to get authorization code
  async function getAuthorizationCode(
    client: typeof testClient,
    user: typeof testUser,
    codeChallenge: string,
    scope: string = "openid profile email"
  ): Promise<string | null> {
    const state = generateUniqueId();
    const redirectUri = client.redirectUris[0];

    // Step 1: GET /oauth/authorize to get session cookie
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

    // Extract the session cookie from the GET response
    // Cookie name is tereo_session_{clientId}
    const setCookieHeader = getResponse.headers.get("set-cookie") || "";
    const sessionCookieMatch = setCookieHeader.match(
      /tereo_session_[^=]+=([^;]+)/
    );
    const sessionCookie = sessionCookieMatch ? sessionCookieMatch[0] : "";

    expect(sessionCookie).toBeTruthy();

    // Step 2: POST credentials with the session cookie
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
        email: user.email,
        password: user.plainPassword,
      }),
      redirect: "manual",
    });

    const authData = (await response.json()) as AuthorizeResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(authData.redirect_url).toContain("/consent");
    const consentUrl = new URL(authData.redirect_url!);
    const sessionId = consentUrl.searchParams.get("session");

    expect(sessionId).toBeTruthy();
    // Extract consent cookie from auth response
    // Cookie name is tereo_consent_session_{clientId}
    const authCookieHeader = response.headers.get("set-cookie") || "";
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
    expect(code).toBeTruthy();
    return code;
  }

  describe("POST /oauth/token - Authorization Code Grant", () => {
    it("should exchange authorization code for tokens with 200 status", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      expect(code).not.toBeNull();

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.access_token).toBeDefined();
      expect(typeof data.access_token).toBe("string");
      expect(data.access_token?.length).toBeGreaterThan(0);
      expect(data.token_type).toBe("Bearer");
      expect(data.expires_in).toBeDefined();
      expect(typeof data.expires_in).toBe("number");
      expect(data.expires_in).toBeGreaterThan(0);
      expect(data.error).toBeUndefined();
    });

    it("should return id_token when openid scope is requested", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();
      expect(typeof data.id_token).toBe("string");
      // ID token should be a JWT with 3 parts separated by dots
      expect(data.id_token!.split(".").length).toBe(3);
    });

    it("should return id_token with valid JWT claims", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();

      // Decode and validate JWT claims
      const [, payloadBase64] = data.id_token!.split(".");
      const payload = JSON.parse(
        Buffer.from(payloadBase64, "base64").toString("utf-8")
      );

      // Required OIDC claims
      expect(payload.iss).toBeDefined();
      expect(typeof payload.iss).toBe("string");

      expect(payload.sub).toBeDefined();
      expect(payload.sub).toBe(testUser.id.toString());

      expect(payload.aud).toBeDefined();
      expect(payload.aud).toBe(testClient.clientId);

      expect(payload.exp).toBeDefined();
      expect(typeof payload.exp).toBe("number");
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      expect(payload.iat).toBeDefined();
      expect(typeof payload.iat).toBe("number");
      expect(payload.iat).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000) + 5
      ); // Allow 5 second tolerance

      // auth_time should be present
      expect(payload.auth_time).toBeDefined();
      expect(typeof payload.auth_time).toBe("number");
    });

    it("should include nonce in id_token when provided in authorization request", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();
      const nonce = generateUniqueId();
      const redirectUri = testClient.redirectUris[0];

      // Get authorization code with nonce
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid profile email");
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
          scope: "openid profile email",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          nonce,
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const authData = (await authResponse.json()) as AuthorizeResponse;

      let code: string | null = null;
      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");
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
      const url = new URL(consentData.redirect_url!);
      code = url.searchParams.get("code");

      expect(code).not.toBeNull();

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

      const data = (await tokenResponse.json()) as TokenResponse;

      expect(tokenResponse.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();

      // Decode and check nonce
      const [, payloadBase64] = data.id_token!.split(".");
      const payload = JSON.parse(
        Buffer.from(payloadBase64, "base64").toString("utf-8")
      );

      expect(payload.nonce).toBe(nonce);
    });

    it("should return refresh_token when offline_access scope is requested", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Request with offline_access scope
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge,
        "openid offline_access"
      );

      expect(code).not.toBeNull();

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.refresh_token).toBeDefined();
      expect(typeof data.refresh_token).toBe("string");
      expect(data.refresh_token!.length).toBeGreaterThan(0);
    });

    it("should reject invalid authorization code with 400 and invalid_grant error", async () => {
      const codeVerifier = generateCodeVerifier();

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "invalid-code",
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("invalid_grant");
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });

    it("should reject invalid code_verifier (PKCE) with 400 and invalid_grant error", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: "wrong-verifier-that-does-not-match-the-challenge",
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("invalid_grant");
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });

    it("should reject mismatched redirect_uri with 400 and invalid_grant error", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://wrong-uri.com/callback",
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("invalid_grant");
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });

    it("should reject reused authorization code with 400 and invalid_grant error", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      expect(code).not.toBeNull();

      // First use - should succeed
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

      // Second use - should fail (code already used)
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
      expect(data.error).toBe("invalid_grant");
      expect(data.access_token).toBeUndefined();
    });

    it("should reject missing code parameter with 400 and invalid_request error", async () => {
      const codeVerifier = generateCodeVerifier();

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBeDefined();
      // RFC 6749 Section 5.2: missing required parameter must be invalid_request
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });

    it("should reject missing code_verifier with 400 and invalid_grant error", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: testClient.redirectUris[0],
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBeDefined();
      // RFC 7636 Section 4.6: PKCE verification failure must be invalid_grant
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });
  });

  describe("POST /oauth/token - Refresh Token Grant", () => {
    it("should refresh access token using refresh_token with 200 status", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Get initial tokens with offline_access
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge,
        "openid offline_access"
      );

      expect(code).not.toBeNull();

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

      // Now use refresh token
      const refreshResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: testClient.clientId,
        }),
      });

      const newTokens = (await refreshResponse.json()) as TokenResponse;

      expect(refreshResponse.status).toBe(HTTP_STATUS.OK);
      expect(newTokens.access_token).toBeDefined();
      expect(typeof newTokens.access_token).toBe("string");
      expect(newTokens.access_token).not.toBe(tokens.access_token);
      expect(newTokens.token_type).toBe("Bearer");
      expect(newTokens.expires_in).toBeDefined();
      expect(newTokens.error).toBeUndefined();

      // Both tokens are stored only as their SHA-256, the lookup key.
      for (const token of [tokens.refresh_token!, newTokens.refresh_token!]) {
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const row = await prisma.refreshToken.findUnique({
          where: { tokenHash },
        });
        expect(row).not.toBeNull();
      }
    });

    it("should reject invalid refresh_token with 400 and invalid_grant error", async () => {
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "invalid-refresh-token",
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("invalid_grant");
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });

    it("should reject missing refresh_token parameter with 400 and invalid_request error", async () => {
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBeDefined();
      // RFC 6749 Section 5.2: missing required parameter must be invalid_request
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });

    it("should reject revoked refresh_token with 400 and invalid_grant error", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Get initial tokens with offline_access
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge,
        "openid offline_access"
      );

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

      // Revoke the refresh token
      await fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
          client_id: testClient.clientId,
        }),
      });

      // Try to use the revoked refresh token
      const refreshResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: testClient.clientId,
        }),
      });

      const data = (await refreshResponse.json()) as TokenResponse;

      expect(refreshResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("invalid_grant");
      expect(data.access_token).toBeUndefined();
    });
  });

  describe("POST /oauth/token - Client Credentials (Confidential Client)", () => {
    it("should require client authentication for confidential clients with 401 error", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Get auth code for confidential client
      const code = await getAuthorizationCode(
        confidentialClient,
        testUser,
        codeChallenge,
        "openid"
      );

      expect(code).not.toBeNull();

      // Try without client_secret
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: confidentialClient.redirectUris[0],
          client_id: confidentialClient.clientId,
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      // Should fail without client_secret for confidential client
      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(data.error).toBe("invalid_client");
      expect(data.access_token).toBeUndefined();
    });

    it("should reject client_secret in body for confidential client (requires Basic Auth) with 401 status", async () => {
      // Create a fresh confidential client for this test
      const freshConfidentialClient = await createTestClient({
        clientType: "confidential",
        scopes: ["openid", "profile"],
      });

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Get auth code for confidential client
      const code = await getAuthorizationCode(
        freshConfidentialClient,
        testUser,
        codeChallenge,
        "openid"
      );

      expect(code).not.toBeNull();

      // Try with client_secret in body (server requires Basic Auth for confidential clients)
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: freshConfidentialClient.redirectUris[0],
          client_id: freshConfidentialClient.clientId,
          client_secret: freshConfidentialClient.plainSecret,
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      // Server requires Basic Auth, not client_secret in body
      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(data.error).toBe("invalid_client");
      expect(data.access_token).toBeUndefined();
    });

    it("should support Basic Auth for confidential client with 200 status", async () => {
      // Create a fresh confidential client for this test
      const freshConfidentialClient = await createTestClient({
        clientType: "confidential",
        scopes: ["openid", "profile"],
      });

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Get auth code for confidential client
      const code = await getAuthorizationCode(
        freshConfidentialClient,
        testUser,
        codeChallenge,
        "openid"
      );

      expect(code).not.toBeNull();

      // Use Basic Auth header
      const credentials = Buffer.from(
        `${freshConfidentialClient.clientId}:${freshConfidentialClient.plainSecret}`
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
          redirect_uri: freshConfidentialClient.redirectUris[0],
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.access_token).toBeDefined();
      expect(data.token_type).toBe("Bearer");
      expect(data.error).toBeUndefined();
    });

    it("should reject invalid client_secret with 401 and invalid_client error", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Get auth code for confidential client
      const code = await getAuthorizationCode(
        confidentialClient,
        testUser,
        codeChallenge,
        "openid"
      );

      expect(code).not.toBeNull();

      // Try with wrong client_secret
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: confidentialClient.redirectUris[0],
          client_id: confidentialClient.clientId,
          client_secret: "wrong-secret",
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(data.error).toBe("invalid_client");
      expect(data.access_token).toBeUndefined();
    });
  });

  describe("POST /oauth/token - Client Credentials Grant", () => {
    let clientCredentialsClient: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      // Create a confidential client with client_credentials grant type
      clientCredentialsClient = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
        scopes: ["openid", "profile"],
      });
    });

    it("should issue access token with client_credentials grant with 200 status (Basic Auth)", async () => {
      // Server requires Basic Auth for confidential clients
      const credentials = Buffer.from(
        `${clientCredentialsClient.clientId}:${clientCredentialsClient.plainSecret}`
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
      expect(typeof data.access_token).toBe("string");
      expect(data.token_type).toBe("Bearer");
      expect(data.expires_in).toBeDefined();
      expect(data.error).toBeUndefined();
      // client_credentials should NOT return refresh_token
      expect(data.refresh_token).toBeUndefined();
    });

    it("introspection reports the client as sub, as the token does", async () => {
      const credentials = Buffer.from(
        `${clientCredentialsClient.clientId}:${clientCredentialsClient.plainSecret}`
      ).toString("base64");
      const tokenRes = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({ grant_type: "client_credentials" }),
      });
      const { access_token } = (await tokenRes.json()) as TokenResponse;

      const res = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({ token: access_token }),
      });
      const data = (await res.json()) as { active: boolean; sub?: string };

      expect(data.active).toBe(true);
      expect(data.sub).toBe(clientCredentialsClient.clientId);
    });

    it("should support Basic Auth for client_credentials grant with 200 status", async () => {
      const credentials = Buffer.from(
        `${clientCredentialsClient.clientId}:${clientCredentialsClient.plainSecret}`
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
      expect(data.error).toBeUndefined();
    });

    it("should reject client_credentials without client authentication with 401 error", async () => {
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: clientCredentialsClient.clientId,
          scope: "openid",
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(data.error).toBe("invalid_client");
      expect(data.access_token).toBeUndefined();
    });

    it("should reject client_credentials for public clients with 400 error", async () => {
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

      // Public clients cannot use client_credentials grant
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("unauthorized_client");
      expect(data.access_token).toBeUndefined();
    });

    it("should reject client_credentials with wrong secret with 401 error", async () => {
      // Server requires Basic Auth for confidential clients
      const credentials = Buffer.from(
        `${clientCredentialsClient.clientId}:wrong-secret`
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
      expect(data.error).toBe("invalid_client");
      expect(data.access_token).toBeUndefined();
    });
  });

  describe("POST /oauth/token - Validation", () => {
    it("should reject unsupported grant_type with 400 and unsupported_grant_type error", async () => {
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          username: testUser.email,
          password: testUser.plainPassword,
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      // RFC 6749 Section 5.2: unsupported_grant_type for unknown grant types
      expect(data.error).toBe(OAUTH_ERRORS.UNSUPPORTED_GRANT_TYPE);
      expect(data.access_token).toBeUndefined();
    });

    it("should reject missing grant_type with 400 and invalid_request error", async () => {
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "some-code",
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBeDefined();
      // RFC 6749 Section 5.2: missing required parameter must be invalid_request
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });

    it("should reject missing client_id with 400 and invalid_request error", async () => {
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "some-code",
        }),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBeDefined();
      // RFC 6749 Section 5.2: missing required parameter must be invalid_request
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });

    it("should reject invalid client_id with 400 and invalid_client error", async () => {
      const codeVerifier = generateCodeVerifier();

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "some-code",
          redirect_uri: "http://localhost:3000/callback",
          client_id: "non-existent-client-id",
          code_verifier: codeVerifier,
        }),
      });

      const data = (await response.json()) as TokenResponse;

      // RFC 6749 Section 5.2: invalid client must return invalid_client error
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
      expect(data.access_token).toBeUndefined();
    });

    it("should reject empty body with 400 and invalid_request error", async () => {
      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBeDefined();
      // RFC 6749 Section 5.2: missing required parameter must be invalid_request
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      expect(data.error_description).toBeDefined();
      expect(data.access_token).toBeUndefined();
    });
  });

  describe("POST /oauth/token - OIDC Compliance", () => {
    it("should include valid at_hash claim in id_token (OIDC Core Section 3.1.3.6)", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      expect(code).not.toBeNull();

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();
      expect(data.access_token).toBeDefined();

      // Decode ID token and validate at_hash
      const claims = decodeJwt(data.id_token!);
      const header = getJwtHeader(data.id_token!);

      // OIDC Core Section 3.1.3.6: at_hash is OPTIONAL for authorization code
      // flow; core always issues it, and it MUST be computed correctly
      expect(claims.at_hash).toBeDefined();
      expect(typeof claims.at_hash).toBe("string");
      expect(claims.at_hash!.length).toBeGreaterThan(0);

      // at_hash should be base64url encoded (no padding, URL-safe characters)
      expect(claims.at_hash).toMatch(/^[A-Za-z0-9_-]+$/);

      // OIDC Core Section 3.1.3.6: at_hash MUST be the base64url encoding of the
      // left-most half of the hash of the octets of the access_token value
      const isValid = verifyAtHash(
        data.access_token!,
        claims.at_hash!,
        header.alg
      );
      expect(isValid).toBe(true);
    });

    it("should verify at_hash computation matches access_token (OIDC Core Section 3.1.3.6)", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      expect(code).not.toBeNull();

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();
      expect(data.access_token).toBeDefined();

      const claims = decodeJwt(data.id_token!);
      const header = getJwtHeader(data.id_token!);

      expect(claims.at_hash).toBeDefined();
      // Verify the at_hash computation matches per OIDC Core Section 3.1.3.6
      const isValidAtHash = verifyAtHash(
        data.access_token!,
        claims.at_hash!,
        header.alg
      );
      expect(isValidAtHash).toBe(true);
    });

    it("should issue the client_id as the single audience, without azp (OIDC Core Section 2)", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      expect(code).not.toBeNull();

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();

      const claims = decodeJwt(data.id_token!);

      // OIDC Core Section 2: If azp is present, it MUST equal the client_id
      // azp is REQUIRED when the ID Token has multiple audiences
      // azp is RECOMMENDED when the ID Token has a single audience and
      // that audience is different from the azp value
      // Core's ID token has the single audience client_id, so it omits azp.
      expect(claims.aud).toBe(testClient.clientId);
      expect(claims.azp).toBeUndefined();
    });

    it("should have valid token expiration times", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      expect(code).not.toBeNull();

      const beforeRequest = Math.floor(Date.now() / 1000);

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

      const afterRequest = Math.floor(Date.now() / 1000);
      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();
      expect(data.expires_in).toBeDefined();

      const claims = decodeJwt(data.id_token!);

      // iat should be approximately now (within request window)
      expect(claims.iat).toBeGreaterThanOrEqual(beforeRequest - 5);
      expect(claims.iat).toBeLessThanOrEqual(afterRequest + 5);

      // exp should be in the future
      expect(claims.exp).toBeGreaterThan(afterRequest);

      // exp should be consistent with expires_in
      // (allow for some processing time difference)
      const expectedExp = claims.iat + data.expires_in!;
      expect(Math.abs(claims.exp - expectedExp)).toBeLessThanOrEqual(5);
    });

    it("should preserve state parameter through authorization flow", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = `test-state-${generateUniqueId()}`;
      const redirectUri = testClient.redirectUris[0];

      // Step 1: GET /oauth/authorize with state
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid profile email");
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
          scope: "openid profile email",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      interface AuthorizeResponse {
        redirect_url?: string;
        error?: string;
      }
      const authData = (await authResponse.json()) as AuthorizeResponse;

      let finalRedirectUrl: string | null = null;

      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");
      const authCookieHeader = authResponse.headers.get("set-cookie") || "";
      const consentCookieMatch = authCookieHeader.match(
        /tereo_consent_session_[^=]+=([^;]+)/
      );
      const consentCookie = consentCookieMatch ? consentCookieMatch[0] : "";

      interface ConsentResponse {
        redirect_url?: string;
      }
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
      finalRedirectUrl = consentData.redirect_url!;

      expect(finalRedirectUrl).not.toBeNull();

      // RFC 6749 Section 4.1.2: state MUST be returned unchanged
      const url = new URL(finalRedirectUrl!);
      expect(url.searchParams.get("state")).toBe(state);
      expect(url.searchParams.get("code")).toBeTruthy();
    });

    it("should issue ID token with valid signature verifiable against JWKS", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      expect(code).not.toBeNull();

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();

      // Verify ID token signature against JWKS
      const { valid, payload } = await verifyIdTokenSignature(data.id_token!);
      expect(valid).toBe(true);
      expect(payload.sub).toBe(testUser.id.toString());
    });

    it("should include auth_time within 5 seconds of actual authentication", async () => {
      const authTimeStart = Math.floor(Date.now() / 1000);

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      const authTimeEnd = Math.floor(Date.now() / 1000);

      expect(code).not.toBeNull();

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();

      const claims = decodeJwt(data.id_token!);

      // auth_time MUST be present and within reasonable bounds
      expect(claims.auth_time).toBeDefined();
      expect(typeof claims.auth_time).toBe("number");

      // auth_time should be between when we started auth and when we finished
      // Allow 5 second tolerance for test execution time
      expect(claims.auth_time).toBeGreaterThanOrEqual(authTimeStart - 5);
      expect(claims.auth_time).toBeLessThanOrEqual(authTimeEnd + 5);
    });

    it("should have issuer in ID token matching discovery document issuer", async () => {
      const discovery = await fetchDiscoveryDocument();

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const code = await getAuthorizationCode(
        testClient,
        testUser,
        codeChallenge
      );

      expect(code).not.toBeNull();

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

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();

      const claims = decodeJwt(data.id_token!);

      // OIDC Core Section 2: iss MUST match the Issuer in discovery document
      expect(claims.iss).toBe(discovery.issuer);
    });

    it("should issue ID token with all required claims validated by validateIdTokenClaims", async () => {
      const discovery = await fetchDiscoveryDocument();

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const nonce = generateUniqueId();
      const state = generateUniqueId();
      const redirectUri = testClient.redirectUris[0];

      // Get authorization code with nonce
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid profile email");
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
          scope: "openid profile email",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          nonce,
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      interface AuthorizeResponse {
        redirect_url?: string;
        error?: string;
      }
      interface ConsentResponse {
        redirect_url?: string;
      }
      const authData = (await authResponse.json()) as AuthorizeResponse;

      let code: string | null = null;
      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");
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
      code = new URL(consentData.redirect_url!).searchParams.get("code");

      expect(code).not.toBeNull();

      const response = await fetch(`${BASE_URL}/oauth/token`, {
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

      const data = (await response.json()) as TokenResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id_token).toBeDefined();

      const claims = decodeJwt(data.id_token!);

      // Use validateIdTokenClaims helper to validate all required claims
      // This will throw if any required claim is missing or invalid
      expect(() => {
        validateIdTokenClaims(
          claims,
          discovery.issuer,
          testClient.clientId,
          testUser.id.toString(),
          nonce
        );
      }).not.toThrow();
    });
  });
});
