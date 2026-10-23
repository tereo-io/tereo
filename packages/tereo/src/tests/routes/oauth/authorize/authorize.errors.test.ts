// @module-tag int
// @module-tag auth
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { createTestUser } from "../../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../../support/auth/crypto.js";

describe("/oauth/authorize", () => {
  describe("OAuth Authorize Endpoint", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;
    let inactiveUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser();
      inactiveUser = await createTestUser({ isActive: false });
    });

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
      it("should return access_denied error for wrong password", async () => {
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
            password: "WrongPassword123!",
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });

      it("should return access_denied error for non-existent user", async () => {
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
            email: "nonexistent@test.local",
            password: "SomePassword123!",
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });

      it("should return access_denied error for inactive user", async () => {
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
            email: inactiveUser.email,
            password: inactiveUser.plainPassword,
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });

      it("password login for a user without a password is Invalid credentials", async () => {
        const passwordless = await createTestUser();
        await prisma.user.update({
          where: { id: passwordless.id },
          data: { passwordHash: null },
        });
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
            email: passwordless.email,
            password: passwordless.plainPassword,
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as ErrorResponse;

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(data.error).toBe("access_denied");
        expect(data.error_description).toBe("Invalid credentials");
      });
    });
  });
});
