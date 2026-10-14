import { describe, it, expect, beforeAll } from "vitest";
import { makeServiceOf } from "../utils/testService.js";
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
  TokenResponse,
  IntrospectResponse,
} from "./utils/test-helpers.js";

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

describe("OAuth Introspect Endpoint", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let testUser: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    testClient = await createTestClient();
    testUser = await createTestUser();
  });

  // Helper to get tokens
  async function getTokens(): Promise<TokenResponse> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateUniqueId();
    const redirectUri = testClient.redirectUris[0];

    // Step 1: GET to get session cookie
    const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", testClient.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set(
      "scope",
      "openid profile email offline_access"
    );
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
        scope: "openid profile email offline_access",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        email: testUser.email,
        password: testUser.plainPassword,
      }),
      redirect: "manual",
    });

    const authData = (await authResponse.json()) as AuthorizeResponse;

    expect(authData.redirect_url).toContain("/consent");
    const consentUrl = new URL(authData.redirect_url!);
    const sessionId = consentUrl.searchParams.get("session");

    expect(sessionId).toBeTruthy();
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
    const code = new URL(consentData.redirect_url!).searchParams.get("code");

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

    return (await tokenResponse.json()) as TokenResponse;
  }

  describe("POST /oauth/introspect", () => {
    it("should return 200 with active=true for valid access token", async () => {
      const tokens = await getTokens();

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokens.access_token,
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(true);
    });

    it("should return complete token metadata per RFC 7662 for valid token", async () => {
      const tokens = await getTokens();

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokens.access_token,
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(true);

      // RFC 7662 recommended fields
      expect(data.scope).toBeDefined();
      expect(typeof data.scope).toBe("string");
      expect(data.scope).toContain("openid");

      expect(data.client_id).toBe(testClient.clientId);

      // Timing claims
      expect(data.exp).toBeDefined();
      expect(typeof data.exp).toBe("number");
      expect(data.exp).toBeGreaterThan(Date.now() / 1000); // Not expired

      expect(data.iat).toBeDefined();
      expect(typeof data.iat).toBe("number");
      expect(data.iat).toBeLessThanOrEqual(Date.now() / 1000 + 5); // Issued recently (within 5 seconds tolerance)

      // Identity claims
      expect(data.sub).toBeDefined();
      expect(typeof data.sub).toBe("string");

      expect(data.iss).toBeDefined();
      expect(typeof data.iss).toBe("string");
    });

    it("should return 200 with active=false for invalid token per RFC 7662", async () => {
      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "invalid-token",
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      // Per RFC 7662 Section 2.2, introspection returns 200 even for invalid tokens
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(false);
      // Invalid tokens should not have metadata
      expect(data.scope).toBeUndefined();
      expect(data.client_id).toBeUndefined();
      expect(data.exp).toBeUndefined();
    });

    it("should return 200 with active=false for revoked token", async () => {
      const tokens = await getTokens();

      // Revoke the token
      const revokeResponse = await fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokens.access_token,
          client_id: testClient.clientId,
        }),
      });
      expect(revokeResponse.status).toBe(HTTP_STATUS.OK);

      // Introspect the revoked token
      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokens.access_token,
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(false);
    });

    it("should accept token_type_hint=access_token parameter", async () => {
      const tokens = await getTokens();

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokens.access_token,
          token_type_hint: "access_token",
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(true);
    });

    it("should return active=false for refresh tokens", async () => {
      const tokens = await getTokens();
      expect(tokens.refresh_token).toBeDefined();

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(false);
    });

    it("should return 400 with invalid_request error when token parameter is missing", async () => {
      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: testClient.clientId,
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as {
        error?: string;
        error_description?: string;
      };
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      expect(data.error_description).toBeDefined();
    });

    it("should support Basic Auth for client authentication", async () => {
      const confidentialClient = await createTestClient({
        clientType: "confidential",
        scopes: ["openid", "profile", "email", "offline_access"],
      });

      // Get tokens for confidential client
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();
      const redirectUri = confidentialClient.redirectUris[0];

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", confidentialClient.clientId);
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
          client_id: confidentialClient.clientId,
          redirect_uri: redirectUri,
          state,
          scope: "openid",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const authData = (await authResponse.json()) as AuthorizeResponse;

      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");

      expect(sessionId).toBeTruthy();
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
      const code = new URL(consentData.redirect_url!).searchParams.get("code");

      // Server requires Basic Auth for confidential clients
      const tokenCredentials = Buffer.from(
        `${confidentialClient.clientId}:${confidentialClient.plainSecret}`
      ).toString("base64");

      const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${tokenCredentials}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      const tokens = (await tokenResponse.json()) as TokenResponse;

      // Introspect with Basic Auth
      const credentials = Buffer.from(
        `${confidentialClient.clientId}:${confidentialClient.plainSecret}`
      ).toString("base64");

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({
          token: tokens.access_token,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(true);
    });

    it("should return 400 with invalid_request error for empty token", async () => {
      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "",
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        error_description?: string;
      };

      // Server validates token is not empty
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    it("should return 200 with active=false for malformed JWT token per RFC 7662", async () => {
      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "not.a.valid.jwt.token",
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      // RFC 7662: Invalid tokens return 200 with active=false
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(false);
    });

    it("should return 200 with active=false for token with invalid signature per RFC 7662", async () => {
      // Using a structurally valid but tampered JWT with invalid signature
      const fakeToken =
        "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.invalid-signature";

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: fakeToken,
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      // RFC 7662: Tokens with invalid signatures are treated as invalid
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(false);
    });

    it("should identify the user by sub, with no username claim", async () => {
      const tokens = await getTokens();

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: tokens.access_token,
          client_id: testClient.clientId,
        }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(true);
      // RFC 7662's username is optional; core names the user by sub only.
      expect(data.sub).toBe(testUser.id);
      expect(data.user_id).toBe(testUser.id);
      expect(data.username).toBeUndefined();
    });

    it("should name a client_credentials token's service account in user_id, its client in sub", async () => {
      const client = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
        scopes: [],
      });
      await makeServiceOf(client.id);
      const account = await prisma.user.findFirstOrThrow({
        where: { oauthClientId: client.id },
      });
      const basic = `Basic ${Buffer.from(
        `${client.clientId}:${client.plainSecret}`
      ).toString("base64")}`;

      const tokenRes = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basic,
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });
      expect(tokenRes.status).toBe(HTTP_STATUS.OK);
      const { access_token } = (await tokenRes.json()) as TokenResponse;

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basic,
        },
        body: new URLSearchParams({ token: access_token! }),
      });
      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(true);
      expect(data.sub).toBe(client.clientId);
      expect(data.user_id).toBe(account.id);
    });

    it("should allow resource server to introspect token when in audience", async () => {
      // Create Service A with Service B in audience
      const serviceA = await createTestClient({
        clientType: "confidential",
        scopes: ["openid", "profile", "email", "offline_access"],
      });

      // Create Service B (resource server)
      const serviceB = await createTestClient({
        clientType: "confidential",
        scopes: [],
      });

      // Service B is a service; Service A's tokens name it in their audience
      const serviceBSlug = await makeServiceOf(serviceB.id);
      const { prisma } = await import("../../utils/db/prisma.js");
      await prisma.oAuthClient.update({
        where: { clientId: serviceA.clientId },
        data: { audience: [serviceBSlug] },
      });

      // Get tokens for Service A
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();
      const redirectUri = serviceA.redirectUris[0];

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", serviceA.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set(
        "scope",
        "openid profile email offline_access"
      );
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
          client_id: serviceA.clientId,
          redirect_uri: redirectUri,
          state,
          scope: "openid profile email offline_access",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const authData = (await authResponse.json()) as AuthorizeResponse;

      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");

      expect(sessionId).toBeTruthy();
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
      const code = new URL(consentData.redirect_url!).searchParams.get("code");

      const tokenCredentials = Buffer.from(
        `${serviceA.clientId}:${serviceA.plainSecret}`
      ).toString("base64");

      const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${tokenCredentials}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      const tokens = (await tokenResponse.json()) as TokenResponse;

      // Service B should be able to introspect
      const credentials = Buffer.from(
        `${serviceB.clientId}:${serviceB.plainSecret}`
      ).toString("base64");

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({ token: tokens.access_token }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(true);
      expect(data.client_id).toBe(serviceA.clientId);
      // A single audience is issued as a string.
      expect(data.aud).toBe(serviceBSlug);
    });

    it("should deny resource server introspecting token not in audience", async () => {
      // Create Service A without Service B in audience
      await createTestClient({
        clientType: "confidential",
        scopes: ["openid", "profile"],
      });

      const serviceB = await createTestClient({
        clientType: "confidential",
        scopes: [],
      });

      // Get tokens for Service A (no audience configured)
      const tokens = await getTokens();

      // Service B should NOT be able to introspect
      const credentials = Buffer.from(
        `${serviceB.clientId}:${serviceB.plainSecret}`
      ).toString("base64");

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({ token: tokens.access_token }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(false);
    });

    it("should allow client to introspect its own tokens regardless of audience", async () => {
      const serviceA = await createTestClient({
        clientType: "confidential",
        scopes: ["openid", "profile", "email", "offline_access"],
      });

      // Set audience that doesn't include self
      const serviceB = await createTestClient({
        clientType: "confidential",
        scopes: [],
      });

      const { prisma } = await import("../../utils/db/prisma.js");
      await prisma.oAuthClient.update({
        where: { clientId: serviceA.clientId },
        data: { audience: [serviceB.clientId] },
      });

      // Get tokens for Service A
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();
      const redirectUri = serviceA.redirectUris[0];

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", serviceA.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set(
        "scope",
        "openid profile email offline_access"
      );
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
          client_id: serviceA.clientId,
          redirect_uri: redirectUri,
          state,
          scope: "openid profile email offline_access",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const authData = (await authResponse.json()) as AuthorizeResponse;

      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");

      expect(sessionId).toBeTruthy();
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
      const code = new URL(consentData.redirect_url!).searchParams.get("code");

      const tokenCredentials = Buffer.from(
        `${serviceA.clientId}:${serviceA.plainSecret}`
      ).toString("base64");

      const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${tokenCredentials}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      const tokens = (await tokenResponse.json()) as TokenResponse;

      // Service A should be able to introspect its own tokens
      const credentials = Buffer.from(
        `${serviceA.clientId}:${serviceA.plainSecret}`
      ).toString("base64");

      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({ token: tokens.access_token }),
      });

      const data = (await response.json()) as IntrospectResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.active).toBe(true);
    });

    it("should include audience in JWT when client has audience configured", async () => {
      // Create Service A and Service B
      const serviceB = await createTestClient({
        clientType: "confidential",
        scopes: [],
      });

      const serviceBSlug = await makeServiceOf(serviceB.id);
      const serviceA = await createTestClient({
        clientType: "confidential",
        scopes: ["openid", "profile", "email", "offline_access"],
        audience: [serviceBSlug], // Set audience directly
      });

      // Get tokens for Service A
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateUniqueId();
      const redirectUri = serviceA.redirectUris[0];

      const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", serviceA.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set(
        "scope",
        "openid profile email offline_access"
      );
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
          client_id: serviceA.clientId,
          redirect_uri: redirectUri,
          state,
          scope: "openid profile email offline_access",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          email: testUser.email,
          password: testUser.plainPassword,
        }),
        redirect: "manual",
      });

      const authData = (await authResponse.json()) as AuthorizeResponse;

      expect(authData.redirect_url).toContain("/consent");
      const consentUrl = new URL(authData.redirect_url!);
      const sessionId = consentUrl.searchParams.get("session");

      expect(sessionId).toBeTruthy();
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
      const code = new URL(consentData.redirect_url!).searchParams.get("code");

      const tokenCredentials = Buffer.from(
        `${serviceA.clientId}:${serviceA.plainSecret}`
      ).toString("base64");

      const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${tokenCredentials}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      const tokens = (await tokenResponse.json()) as TokenResponse;

      // Verify we got an access token
      expect(tokens.access_token).toBeDefined();

      // Decode JWT (without verification, just to check structure)
      const jwtParts = tokens.access_token!.split(".");
      const payload = JSON.parse(
        Buffer.from(jwtParts[1], "base64url").toString("utf-8")
      );

      // Verify audience is in the JWT payload
      // A single audience is issued as a string.
      expect(payload.aud).toBe(serviceBSlug);

      // Also verify Service B can introspect
      const credentials = Buffer.from(
        `${serviceB.clientId}:${serviceB.plainSecret}`
      ).toString("base64");

      const introspectResponse = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: JSON.stringify({ token: tokens.access_token }),
      });

      const introspectData =
        (await introspectResponse.json()) as IntrospectResponse;

      expect(introspectResponse.status).toBe(HTTP_STATUS.OK);
      expect(introspectData.active).toBe(true);
      expect(introspectData.aud).toBeDefined();
    });

    it("should return 401 invalid_client for non-existent client_id", async () => {
      const response = await fetch(`${BASE_URL}/oauth/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "any-token",
          client_id: "non-existent-client-123",
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        error_description?: string;
      };

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_CLIENT);
      expect(data.error_description).toBeDefined();
    });
  });
});
