// @module-tag int
// @module-tag auth
// @module-tag security
import { TokenResponse, decodeJwt } from "../../support/auth/tokens.js";
import { createTestClient } from "../../support/auth/clients.js";
import { createTestUser } from "../../support/auth/users.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
} from "../../support/auth/constants.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../support/auth/crypto.js";

describe("refresh tokens", () => {
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

    describe("Refresh Token Security", () => {
      it("should invalidate old refresh token after rotation", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const { code } = await getAuthorizationCode(testClient, codeChallenge);
        expect(code).toBeTruthy();

        // Get initial tokens
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
        expect(tokens.refresh_token).toBeDefined();

        const originalRefreshToken = tokens.refresh_token;

        // Use refresh token to get new tokens
        const refreshResponse = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: originalRefreshToken,
            client_id: testClient.clientId,
          }),
        });

        expect(refreshResponse.status).toBe(HTTP_STATUS.OK);

        const newTokens = (await refreshResponse.json()) as TokenResponse;
        expect(newTokens.refresh_token).toBeDefined();
        expect(newTokens.refresh_token).not.toBe(originalRefreshToken);

        // Try to use original refresh token again - should fail (rotation)
        const replayResponse = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: originalRefreshToken,
            client_id: testClient.clientId,
          }),
        });

        const replayData = (await replayResponse.json()) as TokenResponse;

        expect(replayResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(replayData.error).toBe(OAUTH_ERRORS.INVALID_GRANT);
      });

      /** A fresh token family for testClient: its first tokens. */
      const startFamily = async (): Promise<TokenResponse> => {
        const codeVerifier = generateCodeVerifier();
        const { code } = await getAuthorizationCode(
          testClient,
          generateCodeChallenge(codeVerifier)
        );
        const res = await fetch(`${BASE_URL}/oauth/token`, {
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
        expect(res.status).toBe(HTTP_STATUS.OK);
        return (await res.json()) as TokenResponse;
      };

      const refresh = (refreshToken: string) =>
        fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: testClient.clientId,
          }),
        });

      const jtiOf = (accessToken: string) =>
        (decodeJwt(accessToken) as unknown as { jti: string }).jti;

      const refreshRow = (jti: string) =>
        prisma.accessToken.findUniqueOrThrow({ where: { jti } }).then((at) =>
          prisma.refreshToken.findUniqueOrThrow({
            where: { id: at.refreshTokenId! },
          })
        );

      const accessRevokedAt = async (accessToken: string) =>
        (
          await prisma.accessToken.findUniqueOrThrow({
            where: { jti: jtiOf(accessToken) },
          })
        ).revokedAt;

      it("refuses a replay just after rotation without ending the family", async () => {
        const first = await startFamily();
        const rotated = await refresh(first.refresh_token!);
        expect(rotated.status).toBe(HTTP_STATUS.OK);
        const second = (await rotated.json()) as TokenResponse;

        const replay = await refresh(first.refresh_token!);
        expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(((await replay.json()) as TokenResponse).error).toBe(
          OAUTH_ERRORS.INVALID_GRANT
        );

        // The successor the first refresh received still works.
        expect(await accessRevokedAt(second.access_token!)).toBeNull();
        const next = await refresh(second.refresh_token!);
        expect(next.status).toBe(HTTP_STATUS.OK);
      });

      it("revokes the family when a token is replayed after the grace period", async () => {
        const first = await startFamily();
        const rotated = await refresh(first.refresh_token!);
        const second = (await rotated.json()) as TokenResponse;

        const old = await refreshRow(jtiOf(first.access_token!));
        expect(old.rotatedAt).not.toBeNull();
        await prisma.refreshToken.update({
          where: { id: old.id },
          data: { rotatedAt: new Date(Date.now() - 60_000) },
        });

        const replay = await refresh(first.refresh_token!);
        expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);

        expect(await accessRevokedAt(second.access_token!)).not.toBeNull();
        const next = await refresh(second.refresh_token!);
        expect(next.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("revokes the family when a token is replayed within the grace after its successor was spent", async () => {
        const first = await startFamily();
        const second = (await (
          await refresh(first.refresh_token!)
        ).json()) as TokenResponse;
        // The thief's chain moves on: the successor is spent too.
        const thirdRes = await refresh(second.refresh_token!);
        expect(thirdRes.status).toBe(HTTP_STATUS.OK);
        const third = (await thirdRes.json()) as TokenResponse;

        // The victim replays the first token, still inside the grace.
        const replay = await refresh(first.refresh_token!);
        expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);

        expect(await accessRevokedAt(third.access_token!)).not.toBeNull();
        const next = await refresh(third.refresh_token!);
        expect(next.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("treats a token revoked at logout as invalid, not as reuse", async () => {
        const first = await startFamily();
        const rotated = await refresh(first.refresh_token!);
        const second = (await rotated.json()) as TokenResponse;

        const revoke = await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: second.refresh_token,
            client_id: testClient.clientId,
          }),
        });
        expect(revoke.status).toBe(HTTP_STATUS.OK);
        const revokedRow = await refreshRow(jtiOf(second.access_token!));
        expect(revokedRow.revokedAt).not.toBeNull();
        expect(revokedRow.rotatedAt).toBeNull();

        const firstAccessBefore = await accessRevokedAt(first.access_token!);
        const replay = await refresh(second.refresh_token!);
        expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(((await replay.json()) as TokenResponse).error).toBe(
          OAUTH_ERRORS.INVALID_GRANT
        );
        // No family revocation ran: the family's other access token is as the
        // revoke left it.
        expect(await accessRevokedAt(first.access_token!)).toEqual(
          firstAccessBefore
        );
      });

      it("does not call a token revoked on its own reuse", async () => {
        const first = await startFamily();
        const rotated = await refresh(first.refresh_token!);
        const second = (await rotated.json()) as TokenResponse;

        // A single token ended by an admin, outside any rotation.
        const row = await refreshRow(jtiOf(second.access_token!));
        await prisma.refreshToken.update({
          where: { id: row.id },
          data: { revokedAt: new Date() },
        });

        const replay = await refresh(second.refresh_token!);
        expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
        // Reuse handling would have revoked the family's live access tokens.
        expect(await accessRevokedAt(first.access_token!)).toBeNull();
        expect(await accessRevokedAt(second.access_token!)).toBeNull();
      });
    });
  });
});
