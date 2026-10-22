// @module-tag int
// @module-tag auth
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { createTestClient } from "../../support/auth/clients.js";
import { browserLogin } from "../../support/browserLogin.js";
import { createTestUser } from "../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import {
  decodeJwt,
  TokenResponse,
  verifyAtHash,
  getJwtHeader,
  verifyIdTokenSignature,
  fetchDiscoveryDocument,
} from "../../support/auth/tokens.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../support/auth/crypto.js";

describe("ID token verification", () => {
  /**
   * OIDC Core 12.2: a refresh of an openid grant returns a fresh ID token for
   * the same login, so a client always holds a usable logout hint.
   */

  const REDIRECT_URI = "http://localhost:3000/refresh-id-token-callback";

  let client: Awaited<ReturnType<typeof createTestClient>>;

  interface Tokens {
    access_token: string;
    refresh_token: string;
    id_token?: string;
  }

  const token = async (params: Record<string, string>) => {
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.clientId, ...params }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Tokens;
  };

  const login = async (scope: string, nonce?: string) => {
    const user = await createTestUser();
    const { jar, code, verifier } = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope,
      nonce,
      email: user.email,
      password: user.plainPassword,
    });
    const tokens = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    return { user, jar, tokens };
  };

  beforeAll(async () => {
    client = await createTestClient({ redirectUris: [REDIRECT_URI] });
  });

  describe("refresh_token grant ID token", () => {
    it("returns a fresh ID token with the login's sid and auth_time, and no nonce", async () => {
      const { user, tokens } = await login(
        "openid profile email offline_access",
        "login-nonce"
      );
      const original = decodeJwt(tokens.id_token!) as unknown as Record<
        string,
        unknown
      >;
      expect(original.nonce).toBe("login-nonce");

      // Distinct iat from the original.
      await new Promise((r) => setTimeout(r, 1100));
      const refreshed = await token({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      });
      expect(refreshed.id_token).toBeTruthy();
      const claims = decodeJwt(refreshed.id_token!) as unknown as Record<
        string,
        unknown
      >;

      expect(claims.sub).toBe(user.id);
      expect(claims.aud).toBe(client.clientId);
      expect(claims.sid).toBe(original.sid);
      expect(claims.sid).toBeTruthy();
      expect(claims.auth_time).toBe(original.auth_time);
      expect(claims.amr).toEqual(original.amr);
      expect(claims.acr).toBe(original.acr);
      expect(claims.email).toBe(user.email);
      expect(claims).not.toHaveProperty("nonce");
      expect(claims.iat as number).toBeGreaterThan(original.iat as number);
      expect(claims.at_hash).not.toBe(original.at_hash);

      // It works as the logout hint, ending the login's SSO session.
      const res = await fetch(
        `${BASE_URL}/oauth/end-session?${new URLSearchParams({
          id_token_hint: refreshed.id_token!,
        })}`,
        { redirect: "manual" }
      );
      expect(res.status).toBe(302);
      expect(
        await prisma.userSession.count({ where: { id: claims.sid as string } })
      ).toBe(0);
    });

    it("returns no ID token for a grant without openid", async () => {
      const { tokens } = await login("profile offline_access");
      expect(tokens.id_token).toBeUndefined();
      const refreshed = await token({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      });
      expect(refreshed.id_token).toBeUndefined();
    });

    it("returns none when the refresh narrows the scope to drop openid", async () => {
      const { tokens } = await login("openid profile offline_access");
      const refreshed = await token({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        scope: "profile",
      });
      expect(refreshed.id_token).toBeUndefined();
    });
  });
});

describe("ID token verification", () => {
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
        const finalRedirectUrl = consentData.redirect_url!;

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
    });
  });
});
