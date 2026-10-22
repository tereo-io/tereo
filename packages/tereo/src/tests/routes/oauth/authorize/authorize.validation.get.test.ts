// @module-tag int
// @module-tag auth
import { expectAuthorizeErrorRedirect } from "../../../support/pure/authorizeErrors.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { describe, it, expect, beforeAll } from "vitest";
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
