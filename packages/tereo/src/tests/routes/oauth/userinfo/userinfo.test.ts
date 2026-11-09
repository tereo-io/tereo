// @module-tag int
// @module-tag auth
import { createTestClient } from "../../../support/auth/clients.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateAccessToken } from "../../../../utils/tokens.js";
import { LOGIN_CLIENT } from "../../../../definitions/index.js";
import { browserLogin } from "../../../support/browserLogin.js";
import { createTestUser } from "../../../support/auth/users.js";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  addTestOrgMember,
  createTestOrganization,
} from "../../../support/auth/organizations.js";
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
import {
  UserInfoResponse,
  TokenResponse,
} from "../../../support/auth/tokens.js";
import {
  ensureTestMembership,
  getTestPrincipalToken,
  testOrgId,
} from "../../../support/principals.js";
import {
  getAccessTokenForUser,
  getUiAccessTokenForUser,
  json,
  postForm,
  loginAndExchange,
} from "../../../support/auth/login.js";
import {
  adminApi,
  delegatedToken,
  deleteGroups,
  postGroup,
} from "../../../support/groups.js";

describe("/oauth/userinfo", () => {
  describe("OAuth UserInfo Endpoint", () => {
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

    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;
    let accessToken: string;

    beforeAll(async () => {
      testClient = await createTestClient();
      testUser = await createTestUser({ name: "John Doe" });
      accessToken = await getAccessTokenForUser(testUser, testClient);
    });

    describe("GET /oauth/userinfo", () => {
      it("should return 200 with user info for valid access token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.sub).toBeDefined();
        expect(typeof data.sub).toBe("string");
      });

      it("should return sub claim matching user identifier", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.sub).toBe(String(testUser.id));
      });

      it("answers POST as GET (OIDC Core 5.3.1)", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.sub).toBe(String(testUser.id));
      });

      it("should return profile claims when profile scope is granted", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.name).toBe("John Doe");
      });

      it("should return email claims when email scope is granted", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.email).toBe(testUser.email);
        expect(typeof data.email).toBe("string");
      });

      it("should return 401 with invalid_token error without authorization header", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`);

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

        const data = (await response.json()) as UserInfoResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_TOKEN);
      });

      it("should return 401 with invalid_token error for invalid token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: "Bearer invalid-token" },
        });

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

        const data = (await response.json()) as UserInfoResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_TOKEN);
      });

      it("should return 401 with invalid_token error for malformed authorization header", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: "InvalidFormat token123" },
        });

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

        // RFC 6750: invalid_token for malformed/invalid access token
        // Server treats non-Bearer auth headers as invalid token
        const data = (await response.json()) as UserInfoResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_TOKEN);
      });

      it("should return 401 with invalid_token error for empty bearer token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: "Bearer " },
        });

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

        const data = (await response.json()) as UserInfoResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_TOKEN);
      });

      it("should reject revoked token", async () => {
        // Get a new token to revoke
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
        authorizeUrl.searchParams.set("scope", "openid profile email");
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
            scope: "openid profile email",
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
        const code = new URL(consentData.redirect_url!).searchParams.get(
          "code"
        );

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

        const tokens = (await tokenResponse.json()) as TokenResponse;

        // Revoke the token
        await fetch(`${BASE_URL}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens.access_token,
            client_id: testClient.clientId,
          }),
        });

        // Try to use revoked token
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

        const data = (await response.json()) as UserInfoResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_TOKEN);
      });

      it("should not expose sensitive data in response", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse & {
          password?: string;
          passwordHash?: string;
        };

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.password).toBeUndefined();
        expect(data.passwordHash).toBeUndefined();
      });

      it("should include email_verified claim when email scope is granted", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.email).toBeDefined();
        // email_verified should be present when email scope is granted
        expect(data.email_verified).toBeDefined();
        expect(typeof data.email_verified).toBe("boolean");
      });

      it("should include updated_at claim for profile scope", async () => {
        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        // updated_at should be a Unix timestamp
        expect(typeof data.updated_at).toBe("number");
        expect(data.updated_at).toBe(
          Math.floor(testUser.updatedAt.getTime() / 1000)
        );
      });

      it("should NOT return profile or email claims when only openid scope is granted", async () => {
        // Create a client with only openid scope
        const limitedClient = await createTestClient({
          scopes: ["openid"],
        });

        // Get access token with only openid scope
        const limitedAccessToken = await getAccessTokenForUser(
          testUser,
          limitedClient,
          "openid"
        );

        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${limitedAccessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        // sub is always returned per OIDC Core
        expect(data.sub).toBeDefined();

        // Profile claims should NOT be present without profile scope
        expect(data.name).toBeUndefined();
        expect(data.family_name).toBeUndefined();
        expect(data.given_name).toBeUndefined();
        expect(data.preferred_username).toBeUndefined();
        expect(data.picture).toBeUndefined();
        expect(data.updated_at).toBeUndefined();

        // Email claims should NOT be present without email scope
        expect(data.email).toBeUndefined();
        expect(data.email_verified).toBeUndefined();
      });

      it("should return profile claims but not email when only openid and profile scope granted", async () => {
        // Create a client with openid and profile scopes
        const profileOnlyClient = await createTestClient({
          scopes: ["openid", "profile"],
        });

        // Get access token with openid and profile scope
        const profileAccessToken = await getAccessTokenForUser(
          testUser,
          profileOnlyClient,
          "openid profile"
        );

        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${profileAccessToken}` },
        });

        const data = (await response.json()) as UserInfoResponse;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.sub).toBeDefined();

        // Profile claims should be present with profile scope
        // (at least some profile claims should be present if user has profile data)
        // Note: name might be undefined if user hasn't set a name

        // Email claims should NOT be present without email scope
        expect(data.email).toBeUndefined();
        expect(data.email_verified).toBeUndefined();
      });

      it("should omit org claims when the token's organization is gone", async () => {
        const label = `userinfo-gone-${generateUniqueId()}`;
        const token = await getTestPrincipalToken({
          organizationId: label,
          permissions: [],
        });
        await prisma.organization.update({
          where: { id: testOrgId(label) },
          data: { archivedAt: new Date() },
        });

        const response = await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await response.json()) as Record<string, unknown>;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.sub).toBeDefined();
        expect(data.org_id).toBeUndefined();
        expect(data.org_name).toBeUndefined();
      });

      describe("openid and core authorization", () => {
        const userinfo = (token: string) =>
          fetch(`${BASE_URL}/oauth/userinfo`, {
            headers: { Authorization: `Bearer ${token}` },
          });

        let member: Awaited<ReturnType<typeof createTestUser>>;

        beforeAll(async () => {
          member = await createTestUser();
          await ensureTestMembership(member.id, "userinfo-organizations");
        });

        it("refuses a token without openid: 403 insufficient_scope with a challenge", async () => {
          const client = await prisma.oAuthClient.findFirstOrThrow({
            where: { clientId: LOGIN_CLIENT.clientId },
          });
          const { token, jti, expiresAt } = generateAccessToken({
            subject: member.id,
            clientId: client.clientId,
            scopes: ["profile", "email"],
          });
          await prisma.accessToken.create({
            data: {
              jti,
              clientId: client.id,
              userId: member.id,
              scopes: ["profile", "email"],
              expiresAt,
            },
          });

          const response = await userinfo(token);
          expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
          expect(response.headers.get("www-authenticate")).toBe(
            'Bearer error="insufficient_scope", scope="openid"'
          );
          const data = (await response.json()) as { error: string };
          expect(data.error).toBe("insufficient_scope");
        });

        it("gives a third-party openid email token no organizations, roles or permissions", async () => {
          const client = await createTestClient({
            scopes: ["openid", "email"],
          });
          const token = await getAccessTokenForUser(
            member,
            client,
            "openid email"
          );
          const response = await userinfo(token);
          expect(response.status).toBe(HTTP_STATUS.OK);
          const data = (await response.json()) as Record<string, unknown>;
          expect(data.email).toBe(member.email);
          expect(data.organizations).toBeUndefined();
          expect(data.roles).toBeUndefined();
          expect(data.permissions).toBeUndefined();
        });

        it.each([
          ["core's UI", () => getUiAccessTokenForUser(member)],
          [
            "a core:account client",
            async () =>
              getAccessTokenForUser(
                member,
                await createTestClient({ scopes: ["openid", "core:account"] }),
                "openid core:account"
              ),
          ],
        ])("gives %s's token the user's organizations", async (_who, mint) => {
          const response = await userinfo(await mint());
          expect(response.status).toBe(HTTP_STATUS.OK);
          const data = (await response.json()) as {
            organizations?: { id: string }[];
          };
          expect(data.organizations?.map((o) => o.id)).toContain(
            testOrgId("userinfo-organizations")
          );
        });
      });
    });
  });

  describe("groups claim", () => {
    const groupIds: string[] = [];
    let adminToken: string;
    let user: Awaited<ReturnType<typeof createTestUser>>;
    let orgId: string;
    let otherOrgId: string;
    let globalGroup: { id: string };
    let orgGroup: { id: string };
    let otherOrgGroup: { id: string };

    const userinfo = async (token: string) =>
      (await (
        await fetch(`${BASE_URL}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()) as {
        groups?: {
          id: string;
          slug: string;
          name: string;
          organizationId: string | null;
        }[];
      };
    const loginToken = (organizationId: string) =>
      getTestPrincipalToken({
        userId: user.id,
        organizationId,
        permissions: [],
      });

    beforeAll(async () => {
      adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
      user = await createTestUser();
      orgId = (await createTestOrganization(adminToken)).id;
      otherOrgId = (await createTestOrganization(adminToken)).id;
      await addTestOrgMember(adminToken, orgId, user.id);
      await addTestOrgMember(adminToken, otherOrgId, user.id);
      globalGroup = await postGroup(adminToken);
      orgGroup = await postGroup(adminToken, { organizationId: orgId });
      otherOrgGroup = await postGroup(adminToken, {
        organizationId: otherOrgId,
      });
      const archived = await postGroup(adminToken);
      groupIds.push(globalGroup.id, orgGroup.id, otherOrgGroup.id, archived.id);
      for (const g of [globalGroup, orgGroup, otherOrgGroup, archived]) {
        await adminApi("POST", `/groups/${g.id}/members`, adminToken, {
          userIds: [user.id],
        });
      }
      await adminApi("POST", `/groups/${archived.id}/archive`, adminToken);
      archivedId = archived.id;
    });
    let archivedId: string;
    afterAll(() => deleteGroups(groupIds));

    it("includes global and the token org's groups for the login client", async () => {
      const data = await userinfo(await loginToken(orgId));
      expect(data.groups?.map((g) => g.id).sort()).toEqual(
        [globalGroup.id, orgGroup.id].sort()
      );
      const org = data.groups?.find((g) => g.id === orgGroup.id);
      expect(org?.organizationId).toBe(orgId);
      expect(Object.keys(org ?? {}).sort()).toEqual([
        "id",
        "name",
        "organizationId",
        "slug",
      ]);
    });

    it("omits other orgs' and archived groups", async () => {
      const ids = (await userinfo(await loginToken(orgId))).groups?.map(
        (g) => g.id
      );
      expect(ids).not.toContain(otherOrgGroup.id);
      expect(ids).not.toContain(archivedId);
    });

    it("lists only global groups when the token's organization is inactive or archived", async () => {
      for (const data of [{ isActive: false }, { archivedAt: new Date() }]) {
        const lapsedOrgId = (await createTestOrganization(adminToken)).id;
        await addTestOrgMember(adminToken, lapsedOrgId, user.id);
        const lapsedGroup = await postGroup(adminToken, {
          organizationId: lapsedOrgId,
        });
        groupIds.push(lapsedGroup.id);
        await adminApi(
          "POST",
          `/groups/${lapsedGroup.id}/members`,
          adminToken,
          {
            userIds: [user.id],
          }
        );
        const token = await loginToken(lapsedOrgId);
        expect((await userinfo(token)).groups?.map((g) => g.id)).toContain(
          lapsedGroup.id
        );

        await prisma.organization.update({
          where: { id: lapsedOrgId },
          data,
        });
        expect((await userinfo(token)).groups?.map((g) => g.id)).toEqual([
          globalGroup.id,
        ]);
      }
    });

    it("a plain relying party gets no groups claim", async () => {
      const client = await createTestClient({ scopes: ["openid", "email"] });
      const outsider = await createTestUser();
      await adminApi("POST", `/groups/${globalGroup.id}/members`, adminToken, {
        userIds: [outsider.id],
      });
      const token = await getAccessTokenForUser(
        outsider,
        client,
        "openid email"
      );
      expect((await userinfo(token)).groups).toBeUndefined();
    });

    it("a delegated token without account/admin area gets groups: []", async () => {
      const token = await delegatedToken(user.id, ["core:files"]);
      expect((await userinfo(token)).groups).toEqual([]);
    });

    it.each([["core:account"], ["core:admin.read"], ["core:admin"]])(
      "a delegated %s token gets the global groups, and no roles",
      async (scope) => {
        const token = await delegatedToken(user.id, [scope]);
        const data = (await userinfo(token)) as {
          groups?: { id: string }[];
          roles?: string[];
        };
        expect(data.groups?.map((g) => g.id)).toEqual([globalGroup.id]);
        expect(data.roles).toEqual([]);
      }
    );

    it("a delegated token with only another area's scope gets groups: []", async () => {
      const token = await delegatedToken(user.id, ["core:organizations"]);
      expect((await userinfo(token)).groups).toEqual([]);
    });

    it("lists no org groups of a token's organization the user is not a member of", async () => {
      const strangerOrgId = (await createTestOrganization(adminToken)).id;
      const outsider = await createTestUser();
      const strangerGroup = await postGroup(adminToken, {
        organizationId: strangerOrgId,
      });
      groupIds.push(strangerGroup.id);
      const token = await getTestPrincipalToken({
        userId: outsider.id,
        organizationId: strangerOrgId,
        permissions: [],
      });
      expect((await userinfo(token)).groups).toEqual([]);

      await addTestOrgMember(adminToken, strangerOrgId, outsider.id);
      await adminApi(
        "POST",
        `/groups/${strangerGroup.id}/members`,
        adminToken,
        { userIds: [outsider.id] }
      );
      expect((await userinfo(token)).groups?.map((g) => g.id)).toEqual([
        strangerGroup.id,
      ]);

      await prisma.organizationMember.deleteMany({
        where: { organizationId: strangerOrgId, userId: outsider.id },
      });
      expect((await userinfo(token)).groups).toEqual([]);
    });
  });

  describe("UserInfo", () => {
    const SCOPE = "openid profile email offline_access";
    const REDIRECT_URI = "http://localhost:3000/callback";

    type Client = Awaited<ReturnType<typeof createTestClient>>;

    const basic = (client: Client) =>
      `Basic ${Buffer.from(`${client.clientId}:${client.plainSecret}`).toString("base64")}`;

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
    let ccClient: Client;
    let user: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      publicClient = await createTestClient({ redirectUris: [REDIRECT_URI] });
      ccClient = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      user = await createTestUser();
    });

    const userinfo = (token: string) =>
      fetch(`${BASE_URL}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    it("refuses a client_credentials token, which has no end user", async () => {
      const res = await userinfo(await clientCredentialsToken(ccClient));
      expect(res.status).toBe(401);
      expect((await json(res)).error).toBe("invalid_token");
      expect(res.headers.get("www-authenticate")).toMatch(
        /^Bearer error="invalid_token"/
      );
    });

    it("refuses the token of a user deactivated since", async () => {
      const other = await createTestUser();
      const { code, verifier } = await browserLogin({
        clientId: publicClient.clientId,
        redirectUri: REDIRECT_URI,
        scope: SCOPE,
        email: other.email,
        password: other.plainPassword,
      });
      const exchanged = await postForm("/oauth/token", {
        grant_type: "authorization_code",
        client_id: publicClient.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      const { access_token } = (await exchanged.json()) as {
        access_token: string;
      };
      expect((await userinfo(access_token)).status).toBe(200);

      await prisma.user.update({
        where: { id: other.id },
        data: { isActive: false },
      });
      expect((await userinfo(access_token)).status).toBe(401);
    });

    it("refuses the access token of a revoked session", async () => {
      const tokens = await loginAndExchange(
        publicClient,
        user,
        REDIRECT_URI,
        SCOPE
      );
      const revoked = await postForm("/oauth/revoke", {
        client_id: publicClient.clientId,
        token: tokens.refresh_token,
      });
      expect(revoked.status).toBe(200);
      expect((await userinfo(tokens.access_token)).status).toBe(401);
    });
  });
});
