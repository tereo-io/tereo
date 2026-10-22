// @module-tag int
// @module-tag auth
import { expectAuthorizeErrorRedirect } from "../../../support/pure/authorizeErrors.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hashPassword } from "../../../../utils/crypto.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { createHash, randomBytes } from "node:crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
  fetchDiscoveryDocument,
} from "../../../support/auth.js";

describe("/oauth/authorize", () => {
  describe("OAuth Authorize Endpoint", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;
    let inactiveUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser();
      inactiveUser = await createTestUser({ isActive: false });
    });

    interface ErrorResponse {
      error?: string;
      error_description?: string;
      message?: string;
      [key: string]: unknown;
    }

    // Helper to get session cookie from authorize GET
    async function getSessionCookie(
      clientId: string,
      redirectUri: string,
      options: {
        scope?: string;
        codeChallenge?: string;
        codeChallengeMethod?: string;
        state?: string;
        prompt?: string;
        maxAge?: number;
        acrValues?: string;
        nonce?: string;
      } = {}
    ): Promise<{ sessionCookie: string; response: Response }> {
      const codeChallenge =
        options.codeChallenge || generateCodeChallenge(generateCodeVerifier());
      const state = options.state || generateUniqueId();

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", options.scope || "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set(
        "code_challenge_method",
        options.codeChallengeMethod || "S256"
      );

      if (options.prompt) {
        authorizeUrl.searchParams.set("prompt", options.prompt);
      }
      if (options.maxAge !== undefined) {
        authorizeUrl.searchParams.set("max_age", options.maxAge.toString());
      }
      if (options.acrValues) {
        authorizeUrl.searchParams.set("acr_values", options.acrValues);
      }
      if (options.nonce) {
        authorizeUrl.searchParams.set("nonce", options.nonce);
      }

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      const setCookieHeader = response.headers.get("set-cookie") || "";
      const sessionCookieMatch = setCookieHeader.match(
        /tereo_session_[^=]+=([^;]+)/
      );
      const sessionCookie = sessionCookieMatch ? sessionCookieMatch[0] : "";

      return { sessionCookie, response };
    }

    describe("POST /oauth/authorize - Credential Submission", () => {
      it("should return access_denied error for wrong password", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = generateUniqueId();

        const { sessionCookie } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { codeChallenge, state }
        );

        const response = await fetch(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            response_type: "code",
            client_id: testClient.clientId,
            redirect_uri: testClient.redirectUris[0],
            state,
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: testUser.email,
            password: "WrongPassword123!",
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });

      it("should return access_denied error for non-existent user", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = generateUniqueId();

        const { sessionCookie } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { codeChallenge, state }
        );

        const response = await fetch(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            response_type: "code",
            client_id: testClient.clientId,
            redirect_uri: testClient.redirectUris[0],
            state,
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: "nonexistent@test.local",
            password: "SomePassword123!",
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });

      it("should return access_denied error for inactive user", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = generateUniqueId();

        const { sessionCookie } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { codeChallenge, state }
        );

        const response = await fetch(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            response_type: "code",
            client_id: testClient.clientId,
            redirect_uri: testClient.redirectUris[0],
            state,
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: inactiveUser.email,
            password: inactiveUser.plainPassword,
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });

      it("password login for a user without a password is Invalid credentials", async () => {
        const passwordless = await createTestUser();
        await prisma.user.update({
          where: { id: passwordless.id },
          data: { passwordHash: null },
        });
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = generateUniqueId();

        const { sessionCookie } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { codeChallenge, state }
        );

        const response = await fetch(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            response_type: "code",
            client_id: testClient.clientId,
            redirect_uri: testClient.redirectUris[0],
            state,
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: passwordless.email,
            password: passwordless.plainPassword,
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });

      it("should return 401 for authentication failure", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = "unique-state-value-12345";

        const { sessionCookie } = await getSessionCookie(
          testClient.clientId,
          testClient.redirectUris[0],
          { codeChallenge, state }
        );

        const response = await fetch(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            response_type: "code",
            client_id: testClient.clientId,
            redirect_uri: testClient.redirectUris[0],
            state,
            scope: "openid",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            email: testUser.email,
            password: "WrongPassword123!",
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });
    });
  });
});

describe("/oauth/authorize", () => {
  // Test entity variables
  let TEST_CLIENT_ID = "";
  let TEST_CLIENT_DB_ID = "";
  const TEST_REDIRECT_URI = "http://localhost:3000/test-callback";

  // Helper functions
  function generateCodeVerifier(): string {
    return randomBytes(32)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  function generateCodeChallenge(verifier: string): string {
    return createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
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
          postLogoutRedirectUris: [],
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

    describe("Authorize Endpoint - response_mode parameter", () => {
      it("should accept response_mode=query (default)", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("response_mode", "query");

        const response = await fetch(url.toString(), { redirect: "manual" });

        // Should redirect without error
        expect(response.status).toBe(HTTP_STATUS.FOUND);
      });

      it("should reject response_mode=fragment, which it does not advertise", async () => {
        const discovery = await fetchDiscoveryDocument();
        expect(discovery.response_modes_supported).toEqual(["query"]);

        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("response_mode", "fragment");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expectAuthorizeErrorRedirect(
          response,
          TEST_REDIRECT_URI,
          "invalid_request",
          "test-state"
        );
      });

      it("should reject response_mode=form_post, which it does not advertise", async () => {
        const discovery = await fetchDiscoveryDocument();
        expect(discovery.response_modes_supported).toEqual(["query"]);

        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("response_mode", "form_post");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expectAuthorizeErrorRedirect(
          response,
          TEST_REDIRECT_URI,
          "invalid_request",
          "test-state"
        );
      });

      it("should reject invalid response_mode with invalid_request error", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const url = new URL(`${BASE_URL}/oauth/authorize`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", TEST_CLIENT_ID);
        url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
        url.searchParams.set("state", "test-state");
        url.searchParams.set("scope", "openid");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("response_mode", "invalid_mode");

        const response = await fetch(url.toString(), { redirect: "manual" });

        expectAuthorizeErrorRedirect(
          response,
          TEST_REDIRECT_URI,
          "invalid_request",
          "test-state"
        );
      });
    });
  });
});
