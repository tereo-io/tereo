// @module-tag int
// @module-tag auth
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { createTestClient } from "../../support/auth/clients.js";
import { browserLogin } from "../../support/browserLogin.js";
import { createTestUser } from "../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../support/auth/crypto.js";
import {
  TokenResponse,
  decodeJwt,
  fetchDiscoveryDocument,
  validateIdTokenClaims,
} from "../../support/auth/tokens.js";

describe("ID token", () => {
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
    let testUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testClient = await createTestClient();
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
        const code = new URL(consentData.redirect_url!).searchParams.get(
          "code"
        );

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
  });
});

describe("ID token", () => {
  const SCOPE = "openid profile email offline_access";
  const REDIRECT_URI = "http://localhost:3000/callback";

  type Client = Awaited<ReturnType<typeof createTestClient>>;

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

  let publicClient: Client;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
    user = await createTestUser();
  });

  describe("ID token claims", () => {
    const exchange = async (scope: string) => {
      const { code, verifier } = await browserLogin({
        clientId: publicClient.clientId,
        redirectUri: REDIRECT_URI,
        scope,
        email: user.email,
        password: user.plainPassword,
      });
      const res = await postForm("/oauth/token", {
        grant_type: "authorization_code",
        client_id: publicClient.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { id_token: string; refresh_token: string };
    };

    const claimsOf = (token: string) =>
      jwt.decode(token) as Record<string, unknown>;

    it("carries the profile and email claims only for their scopes", async () => {
      const bare = claimsOf((await exchange("openid")).id_token);
      expect(bare.sub).toBe(user.id);
      for (const claim of ["email", "email_verified", "name", "updated_at"]) {
        expect(bare).not.toHaveProperty(claim);
      }

      const email = claimsOf((await exchange("openid email")).id_token);
      expect(email.email).toBe(user.email);
      expect(email).not.toHaveProperty("name");

      const profile = claimsOf((await exchange("openid profile")).id_token);
      expect(profile.name).toBe(user.name);
      expect(profile).not.toHaveProperty("email");
    });

    it("follows a refresh's narrowed scope", async () => {
      const { refresh_token } = await exchange(SCOPE);
      const res = await postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: publicClient.clientId,
        refresh_token,
        scope: "openid",
      });
      expect(res.status).toBe(200);
      const claims = claimsOf(
        ((await res.json()) as { id_token: string }).id_token
      );
      expect(claims).not.toHaveProperty("email");
      expect(claims).not.toHaveProperty("name");
    });
  });
});

describe("ID token", () => {
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
        const code = url.searchParams.get("code");

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
    });

    describe("POST /oauth/token - OIDC Compliance", () => {
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
        const code = new URL(consentData.redirect_url!).searchParams.get(
          "code"
        );

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
});
