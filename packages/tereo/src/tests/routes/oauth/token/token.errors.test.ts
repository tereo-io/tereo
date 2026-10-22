// @module-tag int
// @module-tag auth
import { BASE_URL, HTTP_STATUS } from "../../../support/auth/constants.js";
import { getTestPrincipalToken } from "../../../support/principals.js";
import { getAccessTokenForUser } from "../../../support/auth/login.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { InvalidGrantError } from "../../../../utils/errors.js";
import { browserLogin } from "../../../support/browserLogin.js";
import { TokenResponse } from "../../../support/auth/tokens.js";
import { handleRefreshToken } from "../../../../utils/auth.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import db from "../../../../utils/db/index.js";
import { randomBytes } from "node:crypto";
import {
  createTestOrganization,
  addTestOrgMember,
} from "../../../support/auth/organizations.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateUniqueId,
} from "../../../support/auth/crypto.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../support/auth/users.js";

describe("POST /oauth/token", () => {
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

    describe("POST /oauth/token - Refresh Token Grant", () => {
      it("should reject revoked refresh_token with 400 and invalid_grant error", async () => {
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);

        // Get initial tokens with offline_access
        const code = await getAuthorizationCode(
          testClient,
          testUser,
          codeChallenge,
          "openid offline_access"
        );

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

        // Revoke the refresh token
        await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.refresh_token,
            token_type_hint: "refresh_token",
            client_id: testClient.clientId,
          }),
        });

        // Try to use the revoked refresh token
        const refreshResponse = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            client_id: testClient.clientId,
          }),
        });

        const data = (await refreshResponse.json()) as TokenResponse;

        expect(refreshResponse.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_grant");
        expect(data.access_token).toBeUndefined();
      });
    });
  });
});

describe("POST /oauth/token", () => {
  /**
   * A refresh token issued under an organization stops working once the user
   * loses it — deactivated, or their membership removed — including one minted
   * by a refresh racing the deactivation.
   */

  let client: Awaited<ReturnType<typeof createTestClient>>;
  let clientRecord: Awaited<ReturnType<typeof db.clients.getByClientId>>;
  let adminToken: string;

  beforeAll(async () => {
    client = await createTestClient();
    clientRecord = await db.clients.getByClientId(client.clientId);
    adminToken = await getTestPrincipalToken({
      permissions: ["organizations.write", "organizations.read"],
    });
  });

  const setUp = async () => {
    const user = await createTestUser();
    const org = await createTestOrganization(adminToken);
    await addTestOrgMember(adminToken, org.id, user.id);
    const token = randomBytes(32).toString("base64url");
    const id = await db.refreshTokens.create({
      token,
      clientId: clientRecord.id,
      userId: user.id,
      organizationId: org.id,
      scopes: ["openid", "offline_access"],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { user, org, token, id };
  };

  const refresh = (token: string) =>
    handleRefreshToken(clientRecord, {
      grant_type: "refresh_token",
      client_id: client.clientId,
      refresh_token: token,
    });

  const deactivate = (orgId: string) =>
    fetch(`${BASE_URL}/v1/admin/organizations/${orgId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isActive: false }),
    });

  const liveTokens = (organizationId: string) =>
    prisma.refreshToken.count({ where: { organizationId, revokedAt: null } });

  describe("refresh tokens of an organization the user lost", () => {
    it("a refresh token for a deactivated organization is refused and revoked", async () => {
      const { org, token, id } = await setUp();
      // Deactivated without the revocation, as if it had missed this token.
      await prisma.organization.update({
        where: { id: org.id },
        data: { isActive: false },
      });

      await expect(refresh(token)).rejects.toThrow(InvalidGrantError);
      const row = await prisma.refreshToken.findUniqueOrThrow({
        where: { id },
      });
      expect(row.revokedAt).not.toBeNull();
    });

    it("a removed member's refresh token is refused", async () => {
      const { user, org, token } = await setUp();
      await prisma.organizationMember.delete({
        where: {
          organizationId_userId: { organizationId: org.id, userId: user.id },
        },
      });

      await expect(refresh(token)).rejects.toThrow(InvalidGrantError);
      expect(await liveTokens(org.id)).toBe(0);
    });

    it("a refresh in flight during deactivation leaves no live token", async () => {
      const { org, token } = await setUp();

      // The deactivation starts while the refresh holds the user's lock, after
      // its membership check passed and before its successor commits.
      let patch: Promise<Response> | undefined;
      const refreshTokens = db.refreshTokens;
      (db as { refreshTokens: typeof refreshTokens }).refreshTokens = {
        ...refreshTokens,
        create: async (...args) => {
          patch = deactivate(org.id);
          await new Promise((resolve) => setTimeout(resolve, 500));
          return refreshTokens.create(...args);
        },
      };
      try {
        await refresh(token);
      } finally {
        (db as { refreshTokens: typeof refreshTokens }).refreshTokens =
          refreshTokens;
      }

      expect((await patch!).status).toBe(HTTP_STATUS.OK);
      expect(await liveTokens(org.id)).toBe(0);
    });
  });
});

describe("POST /oauth/token", () => {
  const SCOPE = "openid profile email offline_access";
  const REDIRECT_URI = "http://localhost:3000/callback";

  type Client = Awaited<ReturnType<typeof createTestClient>>;

  const basic = (client: Client) =>
    `Basic ${Buffer.from(`${client.clientId}:${client.plainSecret}`).toString("base64")}`;

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

  const clientCredentialsToken = async (client: Client) => {
    const res = await postForm(
      "/oauth/token",
      { grant_type: "client_credentials" },
      { Authorization: basic(client) }
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { access_token: string }).access_token;
  };

  let publicClient: Client;

  beforeAll(async () => {
    publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
  });

  describe("Organization of a code", () => {
    const loginToOrg = async () => {
      const admin = await createAdminUser();
      const adminToken = await getAccessTokenForUser(admin, publicClient);
      const org = await createTestOrganization(adminToken);
      const member = await createTestUser();
      await addTestOrgMember(adminToken, org.id, member.id);

      const { code, verifier } = await browserLogin({
        clientId: publicClient.clientId,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        email: member.email,
        password: member.plainPassword,
      });
      const stored = await prisma.authorizationCode.findFirstOrThrow({
        where: { userId: member.id },
      });
      expect(stored.organizationId).toBe(org.id);
      return { org, member, code, verifier };
    };

    const exchange = (code: string, verifier: string) =>
      postForm("/oauth/token", {
        grant_type: "authorization_code",
        client_id: publicClient.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });

    it("refuses to exchange a code for an organization the user has left since", async () => {
      const { org, member, code, verifier } = await loginToOrg();
      await prisma.organizationMember.delete({
        where: {
          organizationId_userId: { organizationId: org.id, userId: member.id },
        },
      });

      const res = await exchange(code, verifier);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_grant");
    });

    it("mints no client_credentials token for a client whose organization is inactive", async () => {
      const admin = await createAdminUser();
      const adminToken = await getAccessTokenForUser(admin, publicClient);
      const org = await createTestOrganization(adminToken);
      const service = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      await prisma.oAuthClient.update({
        where: { id: service.id },
        data: { organizationId: org.id },
      });
      expect(await clientCredentialsToken(service)).toBeTruthy();

      await prisma.organization.update({
        where: { id: org.id },
        data: { isActive: false },
      });
      const res = await postForm(
        "/oauth/token",
        { grant_type: "client_credentials" },
        { Authorization: basic(service) }
      );
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("unauthorized_client");
    });

    it("refuses to exchange a code for an organization deactivated since", async () => {
      const { org, code, verifier } = await loginToOrg();
      await prisma.organization.update({
        where: { id: org.id },
        data: { isActive: false },
      });

      const res = await exchange(code, verifier);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_grant");
    });
  });
});
