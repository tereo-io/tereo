// @module-tag int
// @module-tag auth
import { cookieHeader, newPkce } from "../../../support/browserLogin.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
  createTestClient,
  createTestUser,
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../../support/auth.js";

describe("POST /oauth/authorize", () => {
  describe("OAuth Authorize Endpoint", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;
    let limitedScopeClient: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser();
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

    describe("POST /oauth/authorize - Credential Submission", () => {
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
  });
});

describe("POST /oauth/authorize", () => {
  const REDIRECT_URI = "http://localhost:3000/callback";

  type Client = Awaited<ReturnType<typeof createTestClient>>;

  const json = async (res: Response) =>
    (await res.json()) as Record<string, unknown>;

  let publicClient: Client;
  let ccClient: Client;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
    ccClient = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    user = await createTestUser();
  });

  describe("Authorization request validation", () => {
    it("refuses the login of a client without the authorization_code grant", async () => {
      const pkce = newPkce();
      const res = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: ccClient.clientId,
          redirect_uri: REDIRECT_URI,
          state: pkce.state,
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          email: user.email,
          password: user.plainPassword,
        }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("unauthorized_client");
    });
  });

  describe("Login step", () => {
    it("answers a missing login-session cookie with invalid_session", async () => {
      const pkce = newPkce();
      const res = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: publicClient.clientId,
          redirect_uri: REDIRECT_URI,
          state: pkce.state,
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          email: user.email,
          password: user.plainPassword,
        }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_session");
    });
  });

  describe("Redirect URI schemes", () => {
    it("refuses a script-capable redirect URI even when it is registered", async () => {
      // Registered before the admin schema refused them.
      const uri = "javascript://x/%0aalert(document.domain)";
      const client = await createTestClient({ redirectUris: [uri] });
      const pkce = newPkce();
      const params = {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: uri,
        state: pkce.state,
        scope: "openid",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      };

      const start = await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
        { redirect: "manual" }
      );
      expect(start.status).toBe(400);
      expect((await json(start)).error).toBe("invalid_request");

      const jar = new Map<string, string>([
        [`tereo_session_${client.clientId}`, "x"],
      ]);
      const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({
          ...params,
          email: user.email,
          password: user.plainPassword,
        }),
      });
      expect(submit.status).toBe(400);
      expect(JSON.stringify(await json(submit))).not.toContain("redirect_url");
    });
  });
});

describe("POST /oauth/authorize", () => {
  interface AuthorizeResponse {
    redirect_url?: string;
    error?: string;
    error_description?: string;
  }

  describe("OAuth Security Tests", () => {
    let testUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testUser = await createTestUser();
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
        expect(redirect.searchParams.get("error_description")).toContain(
          "email"
        );
        expect(redirect.searchParams.get("state")).toBe(state);
        expect(redirect.searchParams.has("code")).toBe(false);
      });
    });
  });
});
