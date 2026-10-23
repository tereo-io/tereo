// @module-tag int
// @module-tag auth
import { expectAuthorizeErrorRedirect } from "../../../support/pure/authorizeErrors.js";
import { fetchDiscoveryDocument } from "../../../support/auth/tokens.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hashPassword } from "../../../../utils/crypto.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
} from "../../../support/auth/constants.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../../support/auth/crypto.js";

describe("GET /oauth/authorize", () => {
  describe("OAuth Authorize Endpoint", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      testClient = await createTestClient();
    });

    interface ErrorResponse {
      error?: string;
      error_description?: string;
      message?: string;
      [key: string]: unknown;
    }

    describe("GET /oauth/authorize - Parameter Validation", () => {
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
        authorizeUrl.searchParams.set(
          "redirect_uri",
          "http://evil.com/callback"
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
        expect(data.error).toBe("invalid_request");
        expect(data.error_description).toBe("Invalid redirect URI");
      });

      it("redirects unsupported_response_type for response_type=token", async () => {
        const codeChallenge = generateCodeChallenge(generateCodeVerifier());
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "token"); // Invalid - only 'code' supported
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        const state = generateUniqueId();
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        expectAuthorizeErrorRedirect(
          response,
          testClient.redirectUris[0],
          "unsupported_response_type",
          state
        );
      });

      it("redirects invalid_request, without state, for a missing state", async () => {
        const codeChallenge = generateCodeChallenge(generateCodeVerifier());
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        // Missing state
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        const params = expectAuthorizeErrorRedirect(
          response,
          testClient.redirectUris[0],
          "invalid_request"
        );
        expect(params.get("error_description")).toEqual(expect.any(String));
        expect(params.has("state")).toBe(false);
      });
    });

    describe("GET /oauth/authorize - Client Grant Type Validation", () => {
      it("redirects unauthorized_client for a client without the authorization_code grant", async () => {
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

        const params = expectAuthorizeErrorRedirect(
          response,
          clientCredentialsOnlyClient.redirectUris[0],
          "unauthorized_client"
        );
        expect(params.get("error_description")).toBe(
          "Client not authorized for authorization code grant"
        );
      });
    });
  });
});

describe("GET /oauth/authorize", () => {
  // Test entity variables
  let TEST_CLIENT_ID = "";
  let TEST_CLIENT_DB_ID = "";
  const TEST_REDIRECT_URI = "http://localhost:3000/test-callback";

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
    });
  });
});
