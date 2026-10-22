// @module-tag int
// @module-tag auth
// @module-tag security
import { expectAuthorizeErrorRedirect } from "../../support/pure/authorizeErrors.js";
import { hashAuthorizationCode } from "../../../utils/crypto.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
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
} from "../../support/auth.js";

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
    scope: string = "openid profile email offline_access",
    user: typeof testUser = testUser
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
        email: user.email,
        password: user.plainPassword,
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
      // A well-formed 43-character challenge, so only the method is at fault.
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const authorize = (method: string, state: string) => {
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", method);
        return fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });
      };

      const state = generateUniqueId();
      const plain = await authorize("plain", state);
      const params = expectAuthorizeErrorRedirect(
        plain,
        testClient.redirectUris[0],
        "invalid_request",
        state
      );
      expect(params.get("error_description")).toContain(
        "code_challenge_method"
      );
      // The same request with S256 is not refused.
      const s256 = await authorize("S256", generateUniqueId());
      expect(
        new URL(s256.headers.get("location") ?? "", BASE_URL).searchParams.get(
          "error"
        )
      ).toBeNull();
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
      const first = (await firstResponse.json()) as TokenResponse;
      expect(first.refresh_token).toBeTruthy();

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

      // The replay revokes what the first exchange issued (RFC 6749 4.1.2).
      const userinfo = await fetch(`${BASE_URL}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${first.access_token}` },
      });
      expect(userinfo.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      const refresh = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
          client_id: testClient.clientId,
        }),
      });
      expect(refresh.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(((await refresh.json()) as TokenResponse).error).toBe(
        OAUTH_ERRORS.INVALID_GRANT
      );
      const { jti } = JSON.parse(
        Buffer.from(first.access_token!.split(".")[1], "base64url").toString()
      ) as { jti: string };
      const accessRow = await prisma.accessToken.findUniqueOrThrow({
        where: { jti },
      });
      expect(accessRow.revokedAt).not.toBeNull();
      const refreshRows = await prisma.refreshToken.findMany({
        where: { authCodeId: accessRow.authCodeId! },
      });
      expect(refreshRows.length).toBeGreaterThan(0);
      expect(refreshRows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    it("should refuse a code whose user was deactivated after authorize", async () => {
      const user = await createTestUser();
      const codeVerifier = generateCodeVerifier();
      const { code } = await getAuthorizationCode(
        testClient,
        generateCodeChallenge(codeVerifier),
        "openid",
        user
      );
      expect(code).toBeTruthy();
      await prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });

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

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(((await response.json()) as TokenResponse).error).toBe(
        OAUTH_ERRORS.INVALID_GRANT
      );
      expect(
        await prisma.accessToken.count({ where: { userId: user.id } })
      ).toBe(0);
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
      const { prisma } = await import("../../../utils/db/prisma.js");
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
});
