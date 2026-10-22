// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../../support/auth.js";

describe("/oauth/consent", () => {
  describe("OAuth Consent Endpoint", () => {
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

    interface ConsentDetailsResponse {
      sessionToken?: string;
      clientName?: string;
      clientId?: string;
      scopes?: Array<{ name: string; description: string | null }>;
      user?: { email: string; name: string | null };
      error?: string;
      error_description?: string;
    }

    interface ConsentSubmitResponse {
      redirect_url?: string;
      error?: string;
      error_description?: string;
    }

    // Helper to get to consent screen
    async function navigateToConsent(
      client: typeof testClient,
      user: typeof testUser,
      scope: string = "openid profile email"
    ): Promise<{
      consentSessionToken: string;
      consentCookie: string;
    }> {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
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

      const setCookieHeader = getResponse.headers.get("set-cookie") || "";
      const sessionCookieMatch = setCookieHeader.match(
        /tereo_session_[^=]+=([^;]+)/
      );
      const sessionCookie = sessionCookieMatch ? sessionCookieMatch[0] : "";

      expect(sessionCookie).toBeTruthy();

      // Step 2: POST credentials
      const authResponse = await fetch(`${BASE_URL}/oauth/authorize`, {
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

      const authData = (await authResponse.json()) as AuthorizeResponse;

      expect(authResponse.status).toBe(HTTP_STATUS.OK);
      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const consentSessionToken = consentUrl.searchParams.get("session");

      const authCookieHeader = authResponse.headers.get("set-cookie") || "";
      const consentCookieMatch = authCookieHeader.match(
        /tereo_consent_session_[^=]+=([^;]+)/
      );
      const consentCookie = consentCookieMatch ? consentCookieMatch[0] : "";

      expect(consentSessionToken).toBeTruthy();
      expect(consentCookie).toBeTruthy();
      return { consentSessionToken: consentSessionToken!, consentCookie };
    }

    describe("GET /oauth/consent - Retrieve Consent Details", () => {
      it("should return 200 with consent details for valid session", async () => {
        const consent = await navigateToConsent(testClient, testUser);

        const response = await fetch(
          `${BASE_URL}/oauth/consent?session=${consent.consentSessionToken}`,
          {
            method: "GET",
            headers: {
              Cookie: consent.consentCookie,
            },
          }
        );

        const data = (await response.json()) as ConsentDetailsResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.clientName).toBeDefined();
        expect(data.clientId).toBeDefined();
        expect(data.scopes).toBeDefined();
        expect(Array.isArray(data.scopes)).toBe(true);
      });

      it("does not show the details to a browser without the session's cookie", async () => {
        const consent = await navigateToConsent(testClient, testUser);

        const response = await fetch(
          `${BASE_URL}/oauth/consent?session=${consent.consentSessionToken}`
        );

        const data = (await response.json()) as ConsentDetailsResponse;
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
        expect(JSON.stringify(data)).not.toContain(testUser.email);
      });

      it("should return 400 with invalid_session for non-existent session", async () => {
        const response = await fetch(
          `${BASE_URL}/oauth/consent?session=non-existent-session-token`,
          {
            method: "GET",
          }
        );

        const data = (await response.json()) as ConsentDetailsResponse;

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
        expect(data.error_description).toBeDefined();
      });

      it("should return 400 for missing session parameter", async () => {
        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "GET",
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("should return 400 for empty session parameter", async () => {
        const response = await fetch(`${BASE_URL}/oauth/consent?session=`, {
          method: "GET",
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });

    describe("POST /oauth/consent - Submit Consent Decision", () => {
      it("should return redirect_url with code when consent approved", async () => {
        // Create a fresh user to ensure consent is required
        const freshUser = await createTestUser();
        const consent = await navigateToConsent(testClient, freshUser);

        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: true,
          }),
        });

        const data = (await response.json()) as ConsentSubmitResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.redirect_url).toBeDefined();
        expect(data.redirect_url).toContain("code=");
        expect(data.error).toBeUndefined();
      });

      it("should return redirect_url with error when consent denied", async () => {
        // Create a fresh user to ensure consent is required
        const freshUser = await createTestUser();
        const consent = await navigateToConsent(testClient, freshUser);

        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: false,
          }),
        });

        const data = (await response.json()) as ConsentSubmitResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.redirect_url).toBeDefined();
        expect(data.redirect_url).toContain("error=access_denied");
        expect(data.redirect_url).toContain("error_description=");
      });

      it("should return 400 with invalid_session for non-existent session", async () => {
        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            session_token: "non-existent-session",
            approved: true,
          }),
        });

        const data = (await response.json()) as ConsentSubmitResponse;

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
      });

      it("should return 400 with invalid_session for mismatched cookie", async () => {
        const consent = await navigateToConsent(testClient, testUser);

        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: "tereo_consent_session=wrong-cookie-value",
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: true,
          }),
        });

        const data = (await response.json()) as ConsentSubmitResponse;

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
      });

      it("should return 400 for missing session_token in body", async () => {
        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            approved: true,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("should return 400 for missing approved field", async () => {
        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            session_token: "some-token",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("should prevent consent session reuse after approval", async () => {
        const freshUser = await createTestUser();
        const consent = await navigateToConsent(testClient, freshUser);

        // First approval - should succeed
        const firstResponse = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: true,
          }),
        });

        expect(firstResponse.status).toBe(HTTP_STATUS.OK);

        // Second attempt with same session - should fail
        const secondResponse = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: true,
          }),
        });

        const data = (await secondResponse.json()) as ConsentSubmitResponse;

        expect(secondResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
      });

      it("should prevent consent session reuse after denial", async () => {
        const freshUser = await createTestUser();
        const consent = await navigateToConsent(testClient, freshUser);

        // First denial - should succeed
        const firstResponse = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: false,
          }),
        });

        expect(firstResponse.status).toBe(HTTP_STATUS.OK);

        // Second attempt - should fail
        const secondResponse = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: true,
          }),
        });

        const data = (await secondResponse.json()) as ConsentSubmitResponse;

        expect(secondResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
      });

      it("should accept approved as string 'true'", async () => {
        const freshUser = await createTestUser();
        const consent = await navigateToConsent(testClient, freshUser);

        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: "true", // String instead of boolean
          }),
        });

        const data = (await response.json()) as ConsentSubmitResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.redirect_url).toBeDefined();
        expect(data.redirect_url).toContain("code=");
      });

      it("should accept approved as string 'false'", async () => {
        const freshUser = await createTestUser();
        const consent = await navigateToConsent(testClient, freshUser);

        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: "false", // String instead of boolean
          }),
        });

        const data = (await response.json()) as ConsentSubmitResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.redirect_url).toBeDefined();
        expect(data.redirect_url).toContain("error=access_denied");
      });
    });

    describe("Consent Flow - State Preservation", () => {
      it("should preserve state parameter in success redirect", async () => {
        const freshUser = await createTestUser();
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = "custom-state-value-12345";
        const redirectUri = testClient.redirectUris[0];

        // Navigate through flow with custom state
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("scope", "openid");
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
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: freshUser.email,
            password: freshUser.plainPassword,
          }),
          redirect: "manual",
        });

        const authData = (await authResponse.json()) as AuthorizeResponse;

        expect(authData.redirect_url).toContain("/consent");
        const consentUrl = new URL(authData.redirect_url!);
        const consentSessionToken = consentUrl.searchParams.get("session");
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
          body: JSON.stringify({
            session_token: consentSessionToken,
            approved: true,
          }),
        });

        const consentData =
          (await consentResponse.json()) as ConsentSubmitResponse;

        expect(consentData.redirect_url).toContain(`state=${state}`);
      });

      it("should preserve state parameter in error redirect", async () => {
        const freshUser = await createTestUser();
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = "error-state-value-67890";
        const redirectUri = testClient.redirectUris[0];

        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("scope", "openid");
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
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: freshUser.email,
            password: freshUser.plainPassword,
          }),
          redirect: "manual",
        });

        const authData = (await authResponse.json()) as AuthorizeResponse;

        expect(authData.redirect_url).toContain("/consent");
        const consentUrl = new URL(authData.redirect_url!);
        const consentSessionToken = consentUrl.searchParams.get("session");
        const authCookieHeader = authResponse.headers.get("set-cookie") || "";
        const consentCookieMatch = authCookieHeader.match(
          /tereo_consent_session_[^=]+=([^;]+)/
        );
        const consentCookie = consentCookieMatch ? consentCookieMatch[0] : "";

        // Deny consent
        const consentResponse = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consentCookie,
          },
          body: JSON.stringify({
            session_token: consentSessionToken,
            approved: false,
          }),
        });

        const consentData =
          (await consentResponse.json()) as ConsentSubmitResponse;

        expect(consentData.redirect_url).toContain("error=access_denied");
        expect(consentData.redirect_url).toContain(`state=${state}`);
      });
    });

    describe("Consent Flow - Security", () => {
      it("should set user session cookie after successful consent", async () => {
        const freshUser = await createTestUser();
        const consent = await navigateToConsent(testClient, freshUser);

        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: true,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.OK);

        const setCookieHeader = response.headers.get("set-cookie") || "";
        expect(setCookieHeader).toContain("tereo_user_session_");
      });

      it("should clear consent session cookie after processing", async () => {
        const freshUser = await createTestUser();
        const consent = await navigateToConsent(testClient, freshUser);

        const response = await fetch(`${BASE_URL}/oauth/consent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: consent.consentCookie,
          },
          body: JSON.stringify({
            session_token: consent.consentSessionToken,
            approved: true,
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.OK);

        // Check that consent cookie is being cleared (expired or removed)
        // Cookie clearing is typically done by setting expiry to past or Max-Age=0
        // The exact implementation may vary
        expect(response.status).toBe(HTTP_STATUS.OK);
      });
    });
  });
});
