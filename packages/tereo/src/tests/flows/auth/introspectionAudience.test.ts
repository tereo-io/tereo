// @module-tag int
// @module-tag auth
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { createTestClient } from "../../support/auth/clients.js";
import { makeServiceOf } from "../../support/testService.js";
import { createTestUser } from "../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../support/auth/crypto.js";
import {
  TokenResponse,
  IntrospectResponse,
} from "../../support/auth/tokens.js";

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
    testClient = await createTestClient({ clientType: "confidential" });
    testUser = await createTestUser();
  });

  const testClientHeaders = () => ({
    "Content-Type": "application/json",
    Authorization: `Basic ${Buffer.from(
      `${testClient.clientId}:${testClient.plainSecret}`
    ).toString("base64")}`,
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
      headers: testClientHeaders(),
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    return (await tokenResponse.json()) as TokenResponse;
  }

  describe("POST /oauth/introspect", () => {
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
      const { prisma } = await import("../../../utils/db/prisma.js");
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

    it("lets a service in a login client's audience introspect that client's user tokens", async () => {
      const { browserLogin } = await import("../../support/browserLogin.js");
      const { prisma } = await import("../../../utils/db/prisma.js");
      const inAudience = await createTestClient({
        clientType: "confidential",
        scopes: [],
      });
      const outside = await createTestClient({
        clientType: "confidential",
        scopes: [],
      });
      const slug = await makeServiceOf(inAudience.id);
      await makeServiceOf(outside.id);
      const loginClient = await createTestClient({
        clientType: "public",
        scopes: ["openid", "profile", "email"],
      });
      await prisma.oAuthClient.update({
        where: { clientId: loginClient.clientId },
        data: { audience: [slug], consentRequired: false },
      });

      const redirectUri = loginClient.redirectUris[0];
      const { code, verifier } = await browserLogin({
        clientId: loginClient.clientId,
        redirectUri,
        scope: "openid profile email",
        email: testUser.email,
        password: testUser.plainPassword,
      });
      const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: loginClient.clientId,
          code_verifier: verifier,
        }),
      });
      const { access_token } = (await tokenResponse.json()) as TokenResponse;

      const introspectAs = async (service: typeof inAudience) => {
        const credentials = Buffer.from(
          `${service.clientId}:${service.plainSecret}`
        ).toString("base64");
        const response = await fetch(`${BASE_URL}/oauth/introspect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${credentials}`,
          },
          body: JSON.stringify({ token: access_token }),
        });
        return (await response.json()) as IntrospectResponse;
      };

      const allowed = await introspectAs(inAudience);
      expect(allowed.active).toBe(true);
      expect(allowed.aud).toBe(slug);
      expect((await introspectAs(outside)).active).toBe(false);
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

      const { prisma } = await import("../../../utils/db/prisma.js");
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
  });
});
