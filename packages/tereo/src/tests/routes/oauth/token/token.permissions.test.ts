// @module-tag int
// @module-tag auth
import { browserLogin } from "../../../support/browserLogin.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
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
} from "../../../support/auth.js";

describe("POST /oauth/token", () => {
  describe("OAuth Token Endpoint", () => {
    let testUser: Awaited<ReturnType<typeof createTestUser>>;
    let confidentialClient: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      testUser = await createTestUser();
      confidentialClient = await createTestClient({
        clientType: "confidential",
      });
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
      client: Awaited<ReturnType<typeof createTestClient>>,
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
  });
});

describe("POST /oauth/token", () => {
  const SCOPE = "openid profile email offline_access";
  const REDIRECT_URI = "http://localhost:3000/callback";

  type Client = Awaited<ReturnType<typeof createTestClient>>;

  const json = async (res: Response) =>
    (await res.json()) as Record<string, unknown>;

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

  const loginAndExchange = async () => {
    const { code, verifier } = await browserLogin({
      clientId: publicClient.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
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
    return (await res.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
  };

  beforeAll(async () => {
    publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
    user = await createTestUser();
  });

  describe("Refresh scope", () => {
    it("narrows to a subset of the granted scopes", async () => {
      const tokens = await loginAndExchange();
      const res = await postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: publicClient.clientId,
        refresh_token: tokens.refresh_token,
        scope: "openid email",
      });
      expect(res.status).toBe(200);
      expect((await json(res)).scope).toBe("openid email");
    });

    it("refuses a scope the refresh token was not granted", async () => {
      const { code, verifier } = await browserLogin({
        clientId: publicClient.clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid offline_access",
        email: user.email,
        password: user.plainPassword,
      });
      const exchanged = await postForm("/oauth/token", {
        grant_type: "authorization_code",
        client_id: publicClient.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      expect(exchanged.status).toBe(200);
      const { refresh_token } = (await exchanged.json()) as {
        refresh_token: string;
      };

      const res = await postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: publicClient.clientId,
        refresh_token,
        scope: "openid email",
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_scope");
    });
  });

  describe("Refresh scope rotation", () => {
    const refresh = (refresh_token: string, scope?: string) =>
      postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: publicClient.clientId,
        refresh_token,
        ...(scope && { scope }),
      });

    it("keeps the whole grant on the rotated refresh token after a narrowed refresh", async () => {
      const tokens = await loginAndExchange();
      const narrowed = await refresh(tokens.refresh_token, "openid");
      expect(narrowed.status).toBe(200);
      const body = (await narrowed.json()) as {
        scope: string;
        refresh_token: string;
      };
      expect(body.scope).toBe("openid");

      const full = await refresh(body.refresh_token);
      expect(full.status).toBe(200);
      expect((await json(full)).scope).toBe(SCOPE);
    });

    it("drops a scope withdrawn from the client since the grant", async () => {
      const client = await createTestClient({ redirectUris: [REDIRECT_URI] });
      const { code, verifier } = await browserLogin({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid offline_access core:account",
        email: user.email,
        password: user.plainPassword,
      });
      const exchanged = await postForm("/oauth/token", {
        grant_type: "authorization_code",
        client_id: client.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      expect(exchanged.status).toBe(200);
      const { refresh_token } = (await exchanged.json()) as {
        refresh_token: string;
      };
      await prisma.oAuthClient.update({
        where: { id: client.id },
        data: { scopes: client.scopes.filter((s) => s !== "core:account") },
      });

      const asked = await postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token,
        scope: "openid core:account",
      });
      expect(asked.status).toBe(200);
      const narrowed = (await asked.json()) as {
        scope: string;
        access_token: string;
        refresh_token: string;
      };
      expect(narrowed.scope).toBe("openid");
      const me = await fetch(`${BASE_URL}/v1/account/me`, {
        headers: { Authorization: `Bearer ${narrowed.access_token}` },
      });
      expect(me.status).not.toBe(200);

      const rotated = await postForm("/oauth/token", {
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: narrowed.refresh_token,
      });
      expect(rotated.status).toBe(200);
      expect((await json(rotated)).scope).toBe("openid offline_access");
    });

    it("does not spend the refresh token on a refused scope", async () => {
      const tokens = await loginAndExchange();
      const refused = await refresh(tokens.refresh_token, "openid admin");
      expect(refused.status).toBe(400);
      expect((await json(refused)).error).toBe("invalid_scope");

      expect((await refresh(tokens.refresh_token)).status).toBe(200);
    });
  });
});

describe("POST /oauth/token", () => {
  describe("OAuth Security Tests", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let confidentialClient: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      // Create confidential client with client_credentials grant for security tests
      confidentialClient = await createTestClient({
        clientType: "confidential",
        grantTypes: [
          "authorization_code",
          "refresh_token",
          "client_credentials",
        ],
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
  });
});
