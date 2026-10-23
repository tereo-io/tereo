// @module-tag int
// @module-tag auth
import { createTestClient } from "../../../support/auth/clients.js";
import { createTestUser } from "../../../support/auth/users.js";
import { TokenResponse } from "../../../support/auth/tokens.js";
import { describe, it, expect, beforeAll } from "vitest";
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

describe("POST /oauth/token", () => {
  describe("OAuth Token Endpoint", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser();
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
    });
  });
});
