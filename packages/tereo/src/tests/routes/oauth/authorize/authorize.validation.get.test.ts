// @module-tag int
// @module-tag auth
import { expectAuthorizeErrorRedirect } from "../../../support/pure/authorizeErrors.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newPkce } from "../../../support/browserLogin.js";
import { hashPassword } from "../../../../utils/crypto.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { createHash, randomBytes } from "node:crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
  createTestClient,
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../../support/auth.js";

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

      it("redirects invalid_request for a missing code_challenge (PKCE required)", async () => {
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        authorizeUrl.searchParams.set("state", generateUniqueId());
        authorizeUrl.searchParams.set("scope", "openid");
        // Missing code_challenge
        authorizeUrl.searchParams.set("code_challenge_method", "S256");

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        expectAuthorizeErrorRedirect(
          response,
          testClient.redirectUris[0],
          "invalid_request"
        );
      });

      it("redirects invalid_request for code_challenge_method=plain", async () => {
        const codeChallenge = generateCodeChallenge(generateCodeVerifier());
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        authorizeUrl.searchParams.set("state", generateUniqueId());
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "plain"); // Invalid - only S256 supported

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        expectAuthorizeErrorRedirect(
          response,
          testClient.redirectUris[0],
          "invalid_request"
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
        expect(params.has("state")).toBe(false);
      });
    });

    describe("GET /oauth/authorize - OIDC Parameters", () => {
      it("redirects invalid_request for a negative or overflowing max_age", async () => {
        const codeChallenge = generateCodeChallenge(generateCodeVerifier());
        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          testClient.redirectUris[0]
        );
        authorizeUrl.searchParams.set("state", generateUniqueId());
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        authorizeUrl.searchParams.set("max_age", "-1");

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        expectAuthorizeErrorRedirect(
          response,
          testClient.redirectUris[0],
          "invalid_request"
        );

        authorizeUrl.searchParams.set("max_age", "99999999999");
        expectAuthorizeErrorRedirect(
          await fetch(authorizeUrl.toString(), { redirect: "manual" }),
          testClient.redirectUris[0],
          "invalid_request"
        );
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
  const REDIRECT_URI = "http://localhost:3000/callback";
  // RFC-variant-0 ids, like the fixtures': z.uuid() would reject them.
  const VARIANT_ZERO_ID = "00000000-0000-7002-0000-000000000001";

  type Client = Awaited<ReturnType<typeof createTestClient>>;

  let publicClient: Client;

  beforeAll(async () => {
    publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
  });

  describe("Authorization request validation", () => {
    const authorize = (overrides: Record<string, string>) => {
      const pkce = newPkce();
      const params = new URLSearchParams({
        response_type: "code",
        client_id: publicClient.clientId,
        redirect_uri: REDIRECT_URI,
        state: pkce.state,
        scope: "openid",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        ...overrides,
      });
      return fetch(`${BASE_URL}/oauth/authorize?${params}`, {
        redirect: "manual",
      });
    };

    it("refuses a code_challenge that is not an S256 digest", async () => {
      const tooLong = await authorize({ code_challenge: "a".repeat(44) });
      expectAuthorizeErrorRedirect(tooLong, REDIRECT_URI, "invalid_request");
      const notBase64url = await authorize({ code_challenge: "+".repeat(43) });
      expectAuthorizeErrorRedirect(
        notBase64url,
        REDIRECT_URI,
        "invalid_request"
      );
    });

    it("accepts an RFC-variant-0 org_id", async () => {
      const res = await authorize({ org_id: VARIANT_ZERO_ID });
      expect(res.status).toBe(302);
    });
  });
});

describe("GET /oauth/authorize", () => {
  describe("OAuth Security Tests", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;

    beforeAll(async () => {
      testClient = await createTestClient();
    });

    describe("Redirect URI Security", () => {
      it("should reject authorization request with unregistered redirect_uri", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = generateUniqueId();

        const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", testClient.clientId);
        authorizeUrl.searchParams.set(
          "redirect_uri",
          "http://malicious-site.com/callback"
        );
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("scope", "openid");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");

        const response = await fetch(authorizeUrl.toString(), {
          method: "GET",
          redirect: "manual",
        });

        // Should return error, not redirect to malicious site
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });
  });
});

describe("GET /oauth/authorize", () => {
  // Test entity variables
  let TEST_CLIENT_ID = "";
  let TEST_CLIENT_DB_ID = "";
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
          postLogoutRedirectUris: [TEST_POST_LOGOUT_URI],
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

    describe("Authorize Endpoint - max_age parameter", () => {
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

    describe("Authorize Endpoint - claims parameter", () => {
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
  });
});
