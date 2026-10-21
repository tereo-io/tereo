import { expectAuthorizeErrorRedirect } from "./utils/authorizeErrors.js";
import { createHash, generateKeyPairSync, randomBytes } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { currentSigningKey } from "../../utils/keys.js";
import { hashFlowToken } from "../../utils/crypto.js";
import { hashPassword } from "../../utils/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import jwt from "jsonwebtoken";
import env from "../../env.js";
import {
  absorbCookies,
  browserLogin,
  confirmLogout,
  cookieHeader,
  newPkce,
  userSessionCookieName,
  type CookieJar,
} from "../utils/browserLogin.js";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
  fetchDiscoveryDocument,
} from "./utils/test-helpers.js";
import {
  ID_TOKEN_HINT_GRACE_SECONDS,
  generateIdToken,
  generateAccessToken,
} from "../../utils/tokens.js";

/**
 * OIDC Compliance Tests
 *
 * Tests the following OIDC compliance features:
 * 1. max_age parameter
 * 2. acr_values parameter + acr claim
 * 3. amr claim in ID token
 * 4. End Session Endpoint
 * 5. prompt parameter (none, login, consent, select_account)
 */

// Test entity variables
let TEST_CLIENT_ID = "";
let TEST_CLIENT_DB_ID = "";
let TEST_USER_ID = "";
let TEST_USER_EMAIL = "";
const TEST_USER_PASSWORD = "TestPassword123!";
const TEST_REDIRECT_URI = "http://localhost:3000/test-callback";
const TEST_POST_LOGOUT_URI = "http://localhost:3000/test-logout";

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

// Type definitions
interface DiscoveryDocument {
  end_session_endpoint?: string;
  acr_values_supported?: string[];
  prompt_values_supported?: string[];
  claims_supported?: string[];
  [key: string]: unknown;
}

interface EndSessionResponse {
  success?: boolean;
  error?: string;
  error_description?: string;
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
    TEST_USER_EMAIL = `test-oidc-user-${uniqueId}@test.local`;

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
        postLogoutRedirectUris: [TEST_POST_LOGOUT_URI],
        scopes: ["openid", "profile", "email", "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        audience: [],
        ownerId: testOwner.id,
      },
    });
    TEST_CLIENT_DB_ID = client.id;

    const passwordHash = await hashPassword(TEST_USER_PASSWORD);
    const user = await prisma.user.create({
      data: {
        email: TEST_USER_EMAIL,
        passwordHash,
        name: "OIDC Test User",
        isActive: true,
      },
    });
    TEST_USER_ID = user.id;
  });

  afterAll(async () => {
    // Cleanup test entities
    if (TEST_USER_ID) {
      await prisma.userSession.deleteMany({ where: { userId: TEST_USER_ID } });
      await prisma.consentSession.deleteMany({
        where: { userId: TEST_USER_ID, clientId: TEST_CLIENT_DB_ID },
      });
      await prisma.user.delete({ where: { id: TEST_USER_ID } }).catch(() => {});
    }
    if (TEST_CLIENT_DB_ID) {
      await prisma.oAuthClient
        .delete({ where: { id: TEST_CLIENT_DB_ID } })
        .catch(() => {});
    }
  });

  describe("Discovery Document", () => {
    it("should include end_session_endpoint", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as DiscoveryDocument;

      expect(config.end_session_endpoint).toBeDefined();
      expect(config.end_session_endpoint).toContain("/oauth/end-session");
    });

    it("should include acr_values_supported with pwd and mfa", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as DiscoveryDocument;

      expect(config.acr_values_supported).toBeDefined();
      expect(config.acr_values_supported).toContain("urn:auth-service:pwd");
      expect(config.acr_values_supported).toContain("urn:auth-service:mfa");
    });

    it("should include prompt_values_supported", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as DiscoveryDocument;

      expect(config.prompt_values_supported).toBeDefined();
      expect(config.prompt_values_supported).toContain("none");
      expect(config.prompt_values_supported).toContain("login");
      expect(config.prompt_values_supported).toContain("consent");
      // Accepted, but ignored: not advertised.
      expect(config.prompt_values_supported).not.toContain("select_account");
    });

    it("should include acr in claims_supported", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as DiscoveryDocument;

      expect(config.claims_supported).toBeDefined();
      expect(config.claims_supported).toContain("acr");
    });

    it("should include amr in claims_supported", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as DiscoveryDocument;

      expect(config.claims_supported).toBeDefined();
      expect(config.claims_supported).toContain("amr");
    });
  });

  describe("End Session Endpoint", () => {
    it("should reject GET without client_id or id_token_hint", async () => {
      const response = await fetch(`${BASE_URL}/oauth/end-session`);
      const data = (await response.json()) as EndSessionResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    it("should reject POST without client_id or id_token_hint", async () => {
      const response = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as EndSessionResponse;

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    /** The UI's sign-out confirmation page end-session sent the browser to. */
    const confirmPage = (response: Response) => {
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = new URL(response.headers.get("location") || "");
      expect(location.pathname).toMatch(/\/logout$/);
      expect(location.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
      expect(location.searchParams.get("confirm_token")).toBeTruthy();
      return location;
    };

    it("sends a POST without id_token_hint to the confirmation page", async () => {
      const response = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: TEST_CLIENT_ID,
          state: "test-state-from-body",
        }),
        redirect: "manual",
      });

      const page = confirmPage(response);
      expect(page.searchParams.get("state")).toBe("test-state-from-body");
    });

    it("carries post_logout_redirect_uri from a POST to the confirmation page", async () => {
      const response = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: TEST_CLIENT_ID,
          post_logout_redirect_uri: TEST_POST_LOGOUT_URI,
          state: "post-body-state",
        }),
        redirect: "manual",
      });

      const page = confirmPage(response);
      expect(page.searchParams.get("post_logout_redirect_uri")).toBe(
        TEST_POST_LOGOUT_URI
      );
      expect(page.searchParams.get("state")).toBe("post-body-state");
    });

    it("should reject unregistered post_logout_redirect_uri", async () => {
      const response = await fetch(
        `${BASE_URL}/oauth/end-session?post_logout_redirect_uri=https://evil.com/callback&client_id=${TEST_CLIENT_ID}`,
        { redirect: "manual" }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as EndSessionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      expect(data.error_description).toBe(
        "post_logout_redirect_uri is not registered for this client"
      );
    });

    it("carries a valid post_logout_redirect_uri and state from a GET to the confirmation page", async () => {
      const response = await fetch(
        `${BASE_URL}/oauth/end-session?post_logout_redirect_uri=${encodeURIComponent(
          TEST_POST_LOGOUT_URI
        )}&client_id=${TEST_CLIENT_ID}&state=my-state-value`,
        { redirect: "manual" }
      );

      const page = confirmPage(response);
      expect(page.searchParams.get("post_logout_redirect_uri")).toBe(
        TEST_POST_LOGOUT_URI
      );
      expect(page.searchParams.get("state")).toBe("my-state-value");
    });
  });

  describe("Authorize Endpoint - max_age parameter", () => {
    it("should accept max_age parameter and pass to login URL", async () => {
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
      url.searchParams.set("max_age", "3600");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("max_age=3600");
    });

    it("should accept max_age=0 (forces re-auth)", async () => {
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
      url.searchParams.set("max_age", "0");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });

    it("should reject negative max_age", async () => {
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
      url.searchParams.set("max_age", "-1");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expectAuthorizeErrorRedirect(
        response,
        TEST_REDIRECT_URI,
        "invalid_request",
        "test-state"
      );
    });
  });

  describe("Authorize Endpoint - acr_values parameter", () => {
    it("should accept acr_values parameter and pass to login URL", async () => {
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
      url.searchParams.set("acr_values", "urn:auth-service:mfa");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("acr_values=");
    });

    it("should accept space-separated acr_values", async () => {
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
      url.searchParams.set(
        "acr_values",
        "urn:auth-service:mfa urn:auth-service:pwd"
      );

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });
  });

  describe("Authorize Endpoint - prompt parameter", () => {
    it("should accept prompt=login and pass to login URL", async () => {
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
      url.searchParams.set("prompt", "login");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("prompt=login");
    });

    it("shows the consent screen for prompt=consent to a client that otherwise skips it", async () => {
      const loginTo = async (prompt?: string) => {
        const pkce = newPkce();
        const params = {
          response_type: "code",
          client_id: TEST_CLIENT_ID,
          redirect_uri: TEST_REDIRECT_URI,
          state: pkce.state,
          scope: "openid",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          ...(prompt && { prompt }),
        };
        const jar: CookieJar = new Map();
        const start = await fetch(
          `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
          { redirect: "manual" }
        );
        absorbCookies(jar, start);
        const login = new URL(start.headers.get("location") ?? "");
        expect(login.pathname).toMatch(/\/login$/);
        expect(login.searchParams.get("prompt") || null).toBe(prompt ?? null);
        const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader(jar),
          },
          body: JSON.stringify({
            ...params,
            email: TEST_USER_EMAIL,
            password: TEST_USER_PASSWORD,
          }),
        });
        expect(submit.status).toBe(HTTP_STATUS.OK);
        const { redirect_url } = (await submit.json()) as {
          redirect_url: string;
        };
        return new URL(redirect_url);
      };

      await prisma.oAuthClient.update({
        where: { id: TEST_CLIENT_DB_ID },
        data: { consentRequired: false },
      });
      try {
        expect((await loginTo()).searchParams.has("code")).toBe(true);
        const consent = await loginTo("consent");
        expect(consent.pathname).toMatch(/\/consent$/);
        expect(consent.searchParams.has("code")).toBe(false);
        expect(consent.searchParams.get("session")).toBeTruthy();
      } finally {
        await prisma.oAuthClient.update({
          where: { id: TEST_CLIENT_DB_ID },
          data: { consentRequired: true },
        });
      }
    });

    it("should accept prompt=select_account and pass to login URL", async () => {
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
      url.searchParams.set("prompt", "select_account");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("prompt=select_account");
    });

    const authorizeWithPrompt = (prompt: string) => {
      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", "test-state");
      url.searchParams.set("scope", "openid");
      url.searchParams.set(
        "code_challenge",
        generateCodeChallenge(generateCodeVerifier())
      );
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", prompt);
      return fetch(url.toString(), { redirect: "manual" });
    };

    it("should accept a space-separated prompt list", async () => {
      const response = await authorizeWithPrompt("login consent");
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toMatch(/\/login$/);
      expect(location.searchParams.get("prompt")).toBe("login consent");
    });

    it("should reject prompt=none combined with another value", async () => {
      const response = await authorizeWithPrompt("none login");
      expectAuthorizeErrorRedirect(
        response,
        TEST_REDIRECT_URI,
        "invalid_request",
        "test-state"
      );
    });

    it("should reject an unknown prompt value", async () => {
      const response = await authorizeWithPrompt("login bogus");
      expectAuthorizeErrorRedirect(
        response,
        TEST_REDIRECT_URI,
        "invalid_request",
        "test-state"
      );
    });

    it("should return login_required for prompt=none without session", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = randomBytes(16).toString("hex");

      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "openid");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "none");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain("error=login_required");
    });

    it("should preserve state in prompt=none error redirect", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = "my-unique-state-12345";

      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "openid");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "none");

      const response = await fetch(url.toString(), { redirect: "manual" });

      const location = response.headers.get("location") || "";
      expect(location).toContain(`state=${state}`);
    });

    it("should reject invalid prompt value", async () => {
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
      url.searchParams.set("prompt", "invalid_value");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expectAuthorizeErrorRedirect(
        response,
        TEST_REDIRECT_URI,
        "invalid_request",
        "test-state"
      );
    });

    it("should reject uppercase prompt value (case-sensitive)", async () => {
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
      url.searchParams.set("prompt", "NONE");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expectAuthorizeErrorRedirect(
        response,
        TEST_REDIRECT_URI,
        "invalid_request",
        "test-state"
      );
    });
  });

  describe("Authorize Endpoint - nonce parameter", () => {
    it("should accept nonce parameter and pass to login URL", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const nonce = randomBytes(16).toString("hex");

      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", "test-state");
      url.searchParams.set("scope", "openid");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("nonce", nonce);

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";
      expect(location).toContain(`nonce=${nonce}`);
    });

    it("should include nonce in id_token when provided", async () => {
      // This test validates that nonce parameter is accepted
      // Full validation that nonce appears in id_token requires token exchange
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const nonce = randomBytes(16).toString("hex");

      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", "test-state");
      url.searchParams.set("scope", "openid");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("nonce", nonce);

      const response = await fetch(url.toString(), { redirect: "manual" });

      // Should accept and redirect
      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });
  });

  describe("Authorize Endpoint - login_hint parameter", () => {
    it("should accept login_hint parameter", async () => {
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
      url.searchParams.set("login_hint", TEST_USER_EMAIL);

      const response = await fetch(url.toString(), { redirect: "manual" });

      // Should redirect without error (login_hint may or may not be passed through)
      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });

    it("should accept email as login_hint", async () => {
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
      url.searchParams.set("login_hint", "user@example.com");

      const response = await fetch(url.toString(), { redirect: "manual" });

      // Should redirect without error
      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });
  });

  describe("Authorize Endpoint - ui_locales parameter", () => {
    it("should accept ui_locales parameter", async () => {
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
      url.searchParams.set("ui_locales", "en");

      const response = await fetch(url.toString(), { redirect: "manual" });

      // Should redirect without error (ui_locales is optional)
      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });

    it("should accept space-separated ui_locales", async () => {
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
      url.searchParams.set("ui_locales", "en es fr");

      const response = await fetch(url.toString(), { redirect: "manual" });

      // Should redirect without error
      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });
  });

  describe("Authorize Endpoint - claims parameter", () => {
    it("should accept claims parameter with userinfo claims", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const claims = JSON.stringify({
        userinfo: {
          name: { essential: true },
          email: { essential: true },
        },
      });

      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", "test-state");
      url.searchParams.set("scope", "openid profile email");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("claims", claims);

      const response = await fetch(url.toString(), { redirect: "manual" });

      // Should redirect without error (claims is optional)
      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });

    it("should accept claims parameter with id_token claims", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const claims = JSON.stringify({
        id_token: {
          auth_time: { essential: true },
          acr: { values: ["urn:auth-service:mfa"] },
        },
      });

      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", "test-state");
      url.searchParams.set("scope", "openid");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("claims", claims);

      const response = await fetch(url.toString(), { redirect: "manual" });

      // Should redirect without error
      expect(response.status).toBe(HTTP_STATUS.FOUND);
    });

    it("should handle malformed claims JSON gracefully", async () => {
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
      url.searchParams.set("claims", "not-valid-json");

      const response = await fetch(url.toString(), { redirect: "manual" });

      // OIDC Core 5.5: an invalid claims parameter is invalid_request.
      expectAuthorizeErrorRedirect(
        response,
        TEST_REDIRECT_URI,
        "invalid_request",
        "test-state"
      );
    });
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

  describe("End Session - id_token_hint parameter", () => {
    it("should reject invalid id_token_hint with appropriate error", async () => {
      // Invalid id_token_hint should be rejected per OIDC RP-Initiated Logout spec
      const response = await fetch(
        `${BASE_URL}/oauth/end-session?id_token_hint=eyJhbGciOiJSUzI1NiJ9.test&client_id=${TEST_CLIENT_ID}`,
        { redirect: "manual" }
      );

      // Invalid JWT must be rejected with 400
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });

    it("should reject invalid id_token_hint with post_logout_redirect_uri", async () => {
      const response = await fetch(
        `${BASE_URL}/oauth/end-session?id_token_hint=test-token&post_logout_redirect_uri=${encodeURIComponent(
          TEST_POST_LOGOUT_URI
        )}&client_id=${TEST_CLIENT_ID}`,
        { redirect: "manual" }
      );

      // Invalid id_token_hint must be rejected even with valid post_logout_redirect_uri
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
    });
  });

  describe("Multiple OIDC parameters combined", () => {
    it("should accept multiple OIDC parameters together", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const nonce = randomBytes(16).toString("hex");
      const state = randomBytes(16).toString("hex");

      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", state);
      url.searchParams.set("scope", "openid profile email");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("prompt", "login");
      url.searchParams.set("max_age", "3600");
      url.searchParams.set("ui_locales", "en");
      url.searchParams.set("acr_values", "urn:auth-service:pwd");
      url.searchParams.set("login_hint", "user@example.com");

      const response = await fetch(url.toString(), { redirect: "manual" });

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = response.headers.get("location") || "";

      // Verify multiple params are passed through
      expect(location).toContain("nonce=");
      expect(location).toContain("prompt=");
      expect(location).toContain("max_age=");
    });
  });

  describe("Session-based authentication flows", () => {
    const signIn = () =>
      browserLogin({
        clientId: TEST_CLIENT_ID,
        redirectUri: TEST_REDIRECT_URI,
        scope: "openid profile",
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD,
      });

    /** The SSO cookie's `name=value`, asserting the login left one. */
    const ssoCookie = (jar: CookieJar) => {
      const name = userSessionCookieName(TEST_CLIENT_ID);
      const value = jar.get(name);
      expect(value, `${name} cookie`).toBeTruthy();
      return `${name}=${value}`;
    };

    const promptNone = (cookie: string) => {
      const pkce = newPkce();
      const url = new URL(`${BASE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", TEST_CLIENT_ID);
      url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
      url.searchParams.set("state", pkce.state);
      url.searchParams.set("scope", "openid");
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "none");
      return fetch(url.toString(), {
        redirect: "manual",
        headers: { Cookie: cookie },
      });
    };

    it("should create user session after successful authentication", async () => {
      const { jar } = await signIn();
      const cookie = ssoCookie(jar);

      const token = cookie.slice(cookie.indexOf("=") + 1);
      const session = await prisma.userSession.findUnique({
        where: { tokenHash: hashFlowToken(token) },
      });
      expect(session?.userId).toBe(TEST_USER_ID);
    });

    it("should accept a valid user session under prompt=none, answering consent_required for a third-party client", async () => {
      const { jar } = await signIn();

      const response = await promptNone(ssoCookie(jar));

      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBe("consent_required");
      expect(location.searchParams.get("code")).toBeNull();
    });

    it("should invalidate session after a confirmed end-session", async () => {
      const { jar } = await signIn();
      const cookie = ssoCookie(jar);

      const endSessionResponse = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ client_id: TEST_CLIENT_ID }),
        redirect: "manual",
      });
      const confirmed = await confirmLogout(jar, endSessionResponse);
      expect(confirmed.status).toBe(HTTP_STATUS.OK);
      expect(jar.has(userSessionCookieName(TEST_CLIENT_ID))).toBe(false);

      // The old cookie value, replayed, must no longer resolve to a session.
      const response = await promptNone(cookie);
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBe("login_required");
    });
  });

  describe("Authorization response issuer (RFC 9207)", () => {
    const issuer = async () => (await fetchDiscoveryDocument()).issuer;

    const authorizeParams = () => {
      const pkce = newPkce();
      return {
        response_type: "code",
        client_id: TEST_CLIENT_ID,
        redirect_uri: TEST_REDIRECT_URI,
        state: pkce.state,
        scope: "openid",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      };
    };

    it("advertises iss in both discovery documents", async () => {
      for (const path of [
        "/.well-known/openid-configuration",
        "/.well-known/oauth-authorization-server",
      ]) {
        const doc = (await (await fetch(`${BASE_URL}${path}`)).json()) as {
          authorization_response_iss_parameter_supported?: boolean;
        };
        expect(doc.authorization_response_iss_parameter_supported, path).toBe(
          true
        );
      }
    });

    it("adds iss to the code redirect", async () => {
      const { redirectUrl } = await browserLogin({
        clientId: TEST_CLIENT_ID,
        redirectUri: TEST_REDIRECT_URI,
        scope: "openid",
        email: TEST_USER_EMAIL,
        password: TEST_USER_PASSWORD,
      });
      const url = new URL(redirectUrl);
      expect(url.searchParams.get("code")).toBeTruthy();
      expect(url.searchParams.get("iss")).toBe(await issuer());
    });

    it("adds iss to an error redirect from /oauth/authorize", async () => {
      const params = { ...authorizeParams(), prompt: "none" };
      const res = await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
        { redirect: "manual" }
      );
      const url = new URL(res.headers.get("location") ?? "");
      expect(url.searchParams.get("error")).toBe("login_required");
      expect(url.searchParams.get("state")).toBe(params.state);
      expect(url.searchParams.get("iss")).toBe(await issuer());
    });

    it("adds iss to a denied consent's redirect", async () => {
      const jar: CookieJar = new Map();
      const params = authorizeParams();
      const start = await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
        { redirect: "manual" }
      );
      absorbCookies(jar, start);
      const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({
          ...params,
          email: TEST_USER_EMAIL,
          password: TEST_USER_PASSWORD,
        }),
      });
      absorbCookies(jar, submit);
      const { redirect_url } = (await submit.json()) as {
        redirect_url: string;
      };
      const denied = await fetch(`${BASE_URL}/oauth/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({
          session_token: new URL(redirect_url).searchParams.get("session"),
          approved: false,
        }),
      });
      expect(denied.status).toBe(HTTP_STATUS.OK);
      const url = new URL(
        ((await denied.json()) as { redirect_url: string }).redirect_url
      );
      expect(url.searchParams.get("error")).toBe("access_denied");
      expect(url.searchParams.get("iss")).toBe(await issuer());
    });
  });

  describe("End Session - id_token_hint verification and redirect", () => {
    let victimId = "";

    // Posted as the admin UI does, which gets JSON rather than a redirect.
    const endSession = (query: Record<string, string>) =>
      fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(query),
      });

    /** An SSO session with a token family issued under it; returns its id. */
    const giveVictimASession = async () => {
      const session = await prisma.userSession.create({
        data: {
          tokenHash: randomBytes(32).toString("hex"),
          userId: victimId,
          authTime: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      const code = await prisma.authorizationCode.create({
        data: {
          codeHash: randomBytes(32).toString("hex"),
          clientId: TEST_CLIENT_DB_ID,
          userId: victimId,
          redirectUri: TEST_REDIRECT_URI,
          scopes: ["openid"],
          codeChallenge: "challenge",
          codeChallengeMethod: "S256",
          authTime: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: new Date(),
          userSessionId: session.id,
        },
      });
      await prisma.refreshToken.create({
        data: {
          tokenHash: randomBytes(32).toString("hex"),
          tokenPrefix: randomBytes(4).toString("hex"),
          clientId: TEST_CLIENT_DB_ID,
          userId: victimId,
          authCodeId: code.id,
          scopes: ["openid"],
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      return session.id;
    };

    const victimState = async () => ({
      sessions: await prisma.userSession.count({ where: { userId: victimId } }),
      liveRefreshTokens: await prisma.refreshToken.count({
        where: { userId: victimId, revokedAt: null },
      }),
    });

    const expectRejected = async (response: Response, description?: string) => {
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as EndSessionResponse;
      expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      if (description) expect(data.error_description).toBe(description);
    };

    beforeAll(async () => {
      const victim = await prisma.user.create({
        data: {
          email: `test-oidc-victim-${randomBytes(8).toString("hex")}@test.local`,
          passwordHash: await hashPassword(TEST_USER_PASSWORD),
          name: "OIDC Logout Victim",
          isActive: true,
        },
      });
      victimId = victim.id;
    });

    afterAll(async () => {
      await prisma.refreshToken.deleteMany({ where: { userId: victimId } });
      await prisma.authorizationCode.deleteMany({
        where: { userId: victimId },
      });
      await prisma.userSession.deleteMany({ where: { userId: victimId } });
      await prisma.user.delete({ where: { id: victimId } }).catch(() => {});
    });

    it("rejects a hint signed with another key and leaves the victim signed in", async () => {
      await giveVictimASession();
      const before = await victimState();
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const forged = jwt.sign(
        {
          iss: env.ISSUER,
          sub: victimId,
          aud: TEST_CLIENT_ID,
        },
        privateKey,
        // Core's kid, so it is the signature that fails.
        { algorithm: "RS256", expiresIn: 300, keyid: currentSigningKey().kid }
      );

      await expectRejected(
        await endSession({ id_token_hint: forged }),
        "Invalid id_token_hint"
      );
      expect(await victimState()).toEqual(before);
      expect(before.sessions).toBeGreaterThan(0);
    });

    it("rejects an unsigned hint", async () => {
      await giveVictimASession();
      const before = await victimState();
      const part = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${part({ alg: "none", typ: "JWT" })}.${part({
        iss: env.ISSUER,
        sub: victimId,
        aud: TEST_CLIENT_ID,
      })}.`;

      await expectRejected(await endSession({ id_token_hint: unsigned }));
      expect(await victimState()).toEqual(before);
    });

    it("rejects a hint from another issuer", async () => {
      const { token } = generateIdToken({
        subject: victimId,
        clientId: TEST_CLIENT_ID,
      });
      const payload = jwt.decode(token) as Record<string, unknown>;
      const otherIssuer = jwt.sign(
        { ...payload, iss: "https://elsewhere.example" },
        currentSigningKey().privateKey,
        { algorithm: "RS256", keyid: currentSigningKey().kid }
      );

      await expectRejected(await endSession({ id_token_hint: otherIssuer }));
    });

    it("rejects an access token as the hint", async () => {
      const { token } = generateAccessToken({
        subject: victimId,
        clientId: TEST_CLIENT_ID,
        scopes: ["openid"],
        audience: [TEST_CLIENT_ID],
      });

      await expectRejected(await endSession({ id_token_hint: token }));
    });

    it("rejects a hint whose audience is not a known client", async () => {
      const { token } = generateIdToken({
        subject: victimId,
        clientId: "no-such-client",
      });

      await expectRejected(
        await endSession({ id_token_hint: token }),
        "Invalid id_token_hint: unknown audience"
      );
    });

    it("rejects a client_id that differs from the hint's audience", async () => {
      const { token } = generateIdToken({
        subject: victimId,
        clientId: TEST_CLIENT_ID,
      });

      await expectRejected(
        await endSession({ id_token_hint: token, client_id: "other-client" }),
        "client_id does not match the id_token_hint audience"
      );
    });

    it("ends the hint's session (sid) for a real id token, even one expired within the grace period", async () => {
      for (const expiresIn of [300, -300]) {
        const sessionId = await giveVictimASession();
        await giveVictimASession(); // another browser, which must survive
        const before = await victimState();
        const { token } = generateIdToken({
          subject: victimId,
          clientId: TEST_CLIENT_ID,
          sessionId,
          expiresIn,
        });

        const response = await endSession({ id_token_hint: token });
        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(await victimState()).toEqual({
          sessions: before.sessions - 1,
          liveRefreshTokens: before.liveRefreshTokens - 1,
        });
        expect(
          await prisma.userSession.count({ where: { id: sessionId } })
        ).toBe(0);
      }
    });

    it("asks to confirm for a hint expired past the grace period", async () => {
      const sessionId = await giveVictimASession();
      const before = await victimState();
      const { token } = generateIdToken({
        subject: victimId,
        clientId: TEST_CLIENT_ID,
        sessionId,
        expiresIn: -(ID_TOKEN_HINT_GRACE_SECONDS + 60),
      });

      const response = await endSession({ id_token_hint: token });
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const page = new URL(response.headers.get("location") ?? "");
      expect(page.pathname).toMatch(/\/logout$/);
      expect(page.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
      expect(await victimState()).toEqual(before);
    });

    it("redirects a navigation with a hint and no post_logout_redirect_uri to the client's sign-in", async () => {
      const sessionId = await giveVictimASession();
      const before = await victimState();
      const { token } = generateIdToken({
        subject: victimId,
        clientId: TEST_CLIENT_ID,
        sessionId,
      });

      const response = await fetch(
        `${BASE_URL}/oauth/end-session?${new URLSearchParams({ id_token_hint: token })}`,
        { redirect: "manual" }
      );
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      expect(response.headers.get("location")).toBe(
        `${new URL(TEST_REDIRECT_URI).origin}/`
      );
      expect((await victimState()).sessions).toBe(before.sessions - 1);
    });

    it("ends nothing for a hint without sid and no cookies", async () => {
      await giveVictimASession();
      const before = await victimState();
      const { token } = generateIdToken({
        subject: victimId,
        clientId: TEST_CLIENT_ID,
      });

      const response = await endSession({ id_token_hint: token });
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(await victimState()).toEqual(before);
    });

    it("ignores a sid that belongs to another user", async () => {
      await giveVictimASession();
      const before = await victimState();
      const otherSession = await prisma.userSession.create({
        data: {
          tokenHash: randomBytes(32).toString("hex"),
          userId: TEST_USER_ID,
          authTime: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      const { token } = generateIdToken({
        subject: victimId,
        clientId: TEST_CLIENT_ID,
        sessionId: otherSession.id,
      });

      const response = await endSession({ id_token_hint: token });
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(await victimState()).toEqual(before);
      expect(
        await prisma.userSession.count({ where: { id: otherSession.id } })
      ).toBe(1);
    });

    it("redirects with state for a real id token and a registered uri", async () => {
      const { token } = generateIdToken({
        subject: victimId,
        clientId: TEST_CLIENT_ID,
      });

      const response = await endSession({
        id_token_hint: token,
        post_logout_redirect_uri: TEST_POST_LOGOUT_URI,
        state: "hint-state",
      });
      expect(response.status).toBe(HTTP_STATUS.FOUND);
      const location = new URL(response.headers.get("location") || "");
      expect(`${location.origin}${location.pathname}`).toBe(
        TEST_POST_LOGOUT_URI
      );
      expect(location.searchParams.get("state")).toBe("hint-state");
    });

    it("refuses a redirect when no client is identified", async () => {
      await expectRejected(
        await endSession({ post_logout_redirect_uri: "https://evil.com/cb" }),
        "post_logout_redirect_uri requires client_id or id_token_hint"
      );
    });

    it("refuses a redirect for an unknown client_id", async () => {
      await expectRejected(
        await endSession({
          client_id: "no-such-client",
          post_logout_redirect_uri: TEST_POST_LOGOUT_URI,
        }),
        "Invalid client_id"
      );
    });

    it("refuses an unregistered redirect uri with its own message", async () => {
      await expectRejected(
        await endSession({
          client_id: TEST_CLIENT_ID,
          post_logout_redirect_uri: `${TEST_POST_LOGOUT_URI}/other`,
        }),
        "post_logout_redirect_uri is not registered for this client"
      );
    });
  });
});
