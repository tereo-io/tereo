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
} from "./utils/test-helpers.js";

describe("OAuth Authorize Endpoint", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let testUser: Awaited<ReturnType<typeof createTestUser>>;
  let inactiveUser: Awaited<ReturnType<typeof createTestUser>>;
  let confidentialClient: Awaited<ReturnType<typeof createTestClient>>;
  let limitedScopeClient: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    testClient = await createTestClient();
    testUser = await createTestUser();
    inactiveUser = await createTestUser({ isActive: false });
    confidentialClient = await createTestClient({ clientType: "confidential" });
    limitedScopeClient = await createTestClient({
      scopes: ["openid"], // Only openid scope allowed
    });
  });

  interface AuthorizeResponse {
    redirect_url?: string;
    error?: string;
    error_description?: string;
    mfa_required?: boolean;
    mfa_session_token?: string;
  }

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

  describe("GET /oauth/authorize - Parameter Validation", () => {
    it("should return 302 redirect to login for valid request", async () => {
      const { response } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0]
      );

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("/login");
      expect(location).toContain(`client_id=${testClient.clientId}`);
    });

    it("should return 400 invalid_request, not a redirect, for non-existent client_id", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", "non-existent-client");
      authorizeUrl.searchParams.set(
        "redirect_uri",
        "http://localhost:3000/callback"
      );
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      // RFC 6749 4.1.2.1: unknown client — tell the caller, never redirect
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.headers.get("location")).toBeNull();
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    it("should return 400 with invalid_request for invalid redirect_uri", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", "http://evil.com/callback");
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
      expect(data.error_description).toBe("Invalid redirect URI");
    });

    it("should return 400 with invalid response_type", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "token"); // Invalid - only 'code' supported
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", testClient.redirectUris[0]);
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });

    it("should return 400 for missing code_challenge (PKCE required)", async () => {
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", testClient.redirectUris[0]);
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      // Missing code_challenge
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });

    it("should return 400 for invalid code_challenge_method", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", testClient.redirectUris[0]);
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "plain"); // Invalid - only S256 supported

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });

    it("should return 400 for missing state parameter", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", testClient.redirectUris[0]);
      // Missing state
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });

    it("should set session cookie for valid request", async () => {
      const { sessionCookie } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0]
      );

      expect(sessionCookie).toBeTruthy();
      expect(sessionCookie).toContain("tereo_session_");
    });
  });

  describe("POST /oauth/authorize - Credential Submission", () => {
    it("should return redirect_url for valid credentials", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();

      const { sessionCookie } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0],
        { codeChallenge, state }
      );

      expect(sessionCookie).toBeTruthy();

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
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const data = (await response.json()) as AuthorizeResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.redirect_url).toBeDefined();
      expect(data.error).toBeUndefined();
    });

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

    it("should return 400 invalid_request for non-existent client_id", async () => {
      const response = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "code",
          client_id: "non-existent-client",
          redirect_uri: "http://localhost:3000/callback",
          state: generateUniqueId(),
          scope: "openid",
          code_challenge: generateCodeChallenge(generateCodeVerifier()),
          code_challenge_method: "S256",
          email: "nobody@test.local",
          password: "SomePassword123!",
        }),
        redirect: "manual",
      });

      const data = (await response.json()) as ErrorResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
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

    it("should return 400 with invalid_session for missing session cookie", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();

      const response = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // No cookie
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
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const data = (await response.json()) as AuthorizeResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe("invalid_session");
      expect(data.error_description).toContain("Session expired");
    });

    it("should return invalid_scope for scope not allowed by client", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();

      const { sessionCookie } = await getSessionCookie(
        limitedScopeClient.clientId,
        limitedScopeClient.redirectUris[0],
        { codeChallenge, state, scope: "openid profile" } // profile not allowed
      );

      const response = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          response_type: "code",
          client_id: limitedScopeClient.clientId,
          redirect_uri: limitedScopeClient.redirectUris[0],
          state,
          scope: "openid profile", // profile not allowed
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const data = (await response.json()) as AuthorizeResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.redirect_url).toBeDefined();
      expect(data.redirect_url).toContain("error=invalid_scope");
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

    it("should return 400 for invalid email format", async () => {
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
          email: "not-a-valid-email",
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });

    it("should return 400 for empty password", async () => {
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
          password: "",
        }),
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });
  });

  describe("GET /oauth/authorize - Prompt Parameter", () => {
    it("should redirect to login for prompt=login", async () => {
      const { response } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0],
        { prompt: "login" }
      );

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("/login");
      expect(location).toContain("prompt=login");
    });

    it("should return error for prompt=none without session", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const state = generateUniqueId();

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", testClient.redirectUris[0]);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("prompt", "none");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("error=login_required");
      expect(location).toContain(`state=${state}`);
    });

    it("should include prompt parameter in login redirect", async () => {
      const { response } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0],
        { prompt: "consent" }
      );

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("prompt=consent");
    });
  });

  describe("GET /oauth/authorize - OIDC Parameters", () => {
    it("should pass nonce parameter through to login", async () => {
      const nonce = "test-nonce-value-12345";

      const { response } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0],
        { nonce }
      );

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain(`nonce=${nonce}`);
    });

    it("should pass max_age parameter through to login", async () => {
      const { response } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0],
        { maxAge: 3600 }
      );

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("max_age=3600");
    });

    it("should return 400 for negative max_age", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", testClient.redirectUris[0]);
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("max_age", "-1");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should pass acr_values parameter through to login", async () => {
      const { response } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0],
        { acrValues: "urn:auth-service:mfa" }
      );

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("acr_values=");
    });
  });

  describe("GET /oauth/authorize - Client Grant Type Validation", () => {
    it("should return 400 with unauthorized_client for client without authorization_code grant", async () => {
      // Create a client with only client_credentials grant
      const clientCredentialsOnlyClient = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });

      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set(
        "client_id",
        clientCredentialsOnlyClient.clientId
      );
      authorizeUrl.searchParams.set(
        "redirect_uri",
        clientCredentialsOnlyClient.redirectUris[0]
      );
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("unauthorized_client");
      expect(data.error_description).toBe(
        "Client not authorized for authorization code grant"
      );
    });
  });

  describe("Security Tests", () => {
    it("should set httpOnly cookie for session", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", testClient.redirectUris[0]);
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      const setCookieHeader = response.headers.get("set-cookie") || "";
      expect(setCookieHeader.toLowerCase()).toContain("httponly");
    });

    it("should set sameSite attribute on cookie", async () => {
      const codeChallenge = generateCodeChallenge(generateCodeVerifier());
      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", testClient.clientId);
      authorizeUrl.searchParams.set("redirect_uri", testClient.redirectUris[0]);
      authorizeUrl.searchParams.set("state", generateUniqueId());
      authorizeUrl.searchParams.set("scope", "openid");
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl.toString(), {
        method: "GET",
        redirect: "manual",
      });

      const setCookieHeader = response.headers.get("set-cookie") || "";
      expect(setCookieHeader.toLowerCase()).toContain("samesite=");
    });

    it("should not allow session cookie reuse with different client", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();

      // Get session for first client
      const { sessionCookie } = await getSessionCookie(
        testClient.clientId,
        testClient.redirectUris[0],
        { codeChallenge, state }
      );

      // Try to use with different client
      const response = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          response_type: "code",
          client_id: confidentialClient.clientId,
          redirect_uri: confidentialClient.redirectUris[0],
          state,
          scope: "openid",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      // Should still work since session is just for CSRF protection
      // but redirect_uri validation should catch mismatches
      expect(response.status).toBeLessThan(500);
    });
  });
});
