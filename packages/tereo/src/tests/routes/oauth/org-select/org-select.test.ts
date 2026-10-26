// @module-tag int
// @module-tag auth
import { getAccessTokenForUser } from "../../../support/auth/login.js";
import { createTestClient } from "../../../support/auth/clients.js";
import { generateUniqueId } from "../../../support/auth/crypto.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  createTestOrganization,
  addTestOrgMember,
} from "../../../support/auth/organizations.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../support/auth/constants.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../support/auth/users.js";
import {
  generateRandomString,
  hashFlowToken,
} from "../../../../utils/crypto.js";

interface OrgSelectGetResponse {
  organizations: Array<{ id: string; name: string; slug: string }>;
  client: { name: string };
  user: { email: string; name: string | null };
  error?: string;
  error_description?: string;
}

interface OrgSelectSubmitResponse {
  redirect_url?: string;
  error?: string;
  error_description?: string;
}

describe("/oauth/org-select and /oauth/org-select/submit", () => {
  describe("OAuth Org Select Endpoints", () => {
    let testClient: Awaited<ReturnType<typeof createTestClient>>;
    let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
    let adminToken: string;
    let testUser: Awaited<ReturnType<typeof createTestUser>>;

    beforeAll(async () => {
      testClient = await createTestClient();
      adminUser = await createAdminUser();
      testUser = await createTestUser();
      adminToken = await getAccessTokenForUser(adminUser, testClient);
    });

    async function createOrgSelectSession(
      userId: string,
      clientInternalId: string,
      options: { expiresInMs?: number } = {}
    ) {
      const sessionToken = generateRandomString(32);
      const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 120_000));

      const session = await prisma.orgSelectionSession.create({
        data: {
          tokenHash: hashFlowToken(sessionToken),
          userId,
          clientId: clientInternalId,
          redirectUri: "http://localhost:3000/callback",
          scopes: ["openid", "profile"],
          state: generateUniqueId(),
          codeChallenge: "test-challenge",
          codeChallengeMethod: "S256",
          nonce: null,
          authTime: new Date(),
          maxAge: null,
          acrValues: null,
          prompt: null,
          authMethods: ["password"],
          expiresAt,
        },
      });

      return { session, sessionToken };
    }

    /** The org picker's GET, from the browser holding the session's cookie. */
    const getOrgSelect = (sessionToken: string, cookie = sessionToken) =>
      fetch(`${BASE_URL}/oauth/org-select?session=${sessionToken}`, {
        headers: {
          Cookie: `tereo_org_select_session_${testClient.clientId}=${cookie}`,
        },
      });

    // ===========================================================================
    // GET /oauth/org-select
    // ===========================================================================

    describe("GET /oauth/org-select", () => {
      it("should return organizations for a valid session", async () => {
        const org = await createTestOrganization(adminToken);
        await addTestOrgMember(adminToken, org.id, testUser.id);

        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id
        );

        const response = await getOrgSelect(sessionToken);

        const data = (await response.json()) as OrgSelectGetResponse;
        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(Array.isArray(data.organizations)).toBe(true);
        expect(data.organizations.length).toBeGreaterThanOrEqual(1);
        expect(data.client).toBeDefined();
        expect(data.user).toBeDefined();
        expect(data.user.email).toBe(testUser.email);
      });

      it("should only return active organizations", async () => {
        const activeOrg = await createTestOrganization(adminToken);
        const inactiveOrg = await createTestOrganization(adminToken);
        await addTestOrgMember(adminToken, activeOrg.id, testUser.id);
        await addTestOrgMember(adminToken, inactiveOrg.id, testUser.id);

        // Deactivate one org
        await fetch(`${BASE_URL}/v1/admin/organizations/${inactiveOrg.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        });

        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id
        );

        const response = await getOrgSelect(sessionToken);

        const data = (await response.json()) as OrgSelectGetResponse;
        expect(response.status).toBe(HTTP_STATUS.OK);
        const orgIds = data.organizations.map((o) => o.id);
        expect(orgIds).toContain(activeOrg.id);
        expect(orgIds).not.toContain(inactiveOrg.id);
      });

      it("should return 400 for invalid session token", async () => {
        const response = await fetch(
          `${BASE_URL}/oauth/org-select?session=nonexistent-session-token`
        );

        const data = (await response.json()) as OrgSelectSubmitResponse;
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
      });

      it("does not show the user's details to a browser without the session's cookie", async () => {
        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id
        );

        for (const response of [
          await fetch(`${BASE_URL}/oauth/org-select?session=${sessionToken}`),
          await getOrgSelect(sessionToken, generateRandomString(32)),
        ]) {
          const data = (await response.json()) as OrgSelectGetResponse;
          expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
          expect(data.error).toBe("invalid_session");
          expect(data.user).toBeUndefined();
        }
      });

      it("should return 400 for expired session", async () => {
        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id,
          { expiresInMs: -1000 } // Already expired
        );

        const response = await getOrgSelect(sessionToken);

        const data = (await response.json()) as OrgSelectSubmitResponse;
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("session_expired");
      });
    });

    // ===========================================================================
    // POST /oauth/org-select/submit
    // ===========================================================================

    describe("POST /oauth/org-select/submit", () => {
      it("should return 400 for invalid session token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/org-select/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "nonexistent-session-token",
            organization_id: NON_EXISTENT_UUID,
          }),
        });

        const data = (await response.json()) as OrgSelectSubmitResponse;
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
      });

      it("should return 400 when session cookie is missing (CSRF protection)", async () => {
        const org = await createTestOrganization(adminToken);
        await addTestOrgMember(adminToken, org.id, testUser.id);

        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id
        );

        // Submit without the org-select cookie
        const response = await fetch(`${BASE_URL}/oauth/org-select/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: sessionToken,
            organization_id: org.id,
          }),
        });

        const data = (await response.json()) as OrgSelectSubmitResponse;
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("invalid_session");
      });

      it("should return 400 for expired session", async () => {
        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id,
          { expiresInMs: -1000 }
        );

        const cookieName = `tereo_org_select_session_${testClient.clientId}`;
        const response = await fetch(`${BASE_URL}/oauth/org-select/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${cookieName}=${sessionToken}`,
          },
          body: JSON.stringify({
            session_token: sessionToken,
            organization_id: NON_EXISTENT_UUID,
          }),
        });

        const data = (await response.json()) as OrgSelectSubmitResponse;
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("session_expired");
      });

      it("should return 400 when user is not in the selected organization", async () => {
        const org = await createTestOrganization(adminToken);
        // Do NOT add testUser to this org

        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id
        );

        const cookieName = `tereo_org_select_session_${testClient.clientId}`;
        const response = await fetch(`${BASE_URL}/oauth/org-select/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${cookieName}=${sessionToken}`,
          },
          body: JSON.stringify({
            session_token: sessionToken,
            organization_id: org.id,
          }),
        });

        const data = (await response.json()) as OrgSelectSubmitResponse;
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("user_not_in_organization");
      });

      it("should return 400 when selected organization is not active", async () => {
        const org = await createTestOrganization(adminToken);
        await addTestOrgMember(adminToken, org.id, testUser.id);

        // Deactivate the org
        await fetch(`${BASE_URL}/v1/admin/organizations/${org.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        });

        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id
        );

        const cookieName = `tereo_org_select_session_${testClient.clientId}`;
        const response = await fetch(`${BASE_URL}/oauth/org-select/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${cookieName}=${sessionToken}`,
          },
          body: JSON.stringify({
            session_token: sessionToken,
            organization_id: org.id,
          }),
        });

        await response.json();
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("refuses an archived organization with organization_not_active, not 404", async () => {
        const org = await createTestOrganization(adminToken);
        await addTestOrgMember(adminToken, org.id, testUser.id);
        const adminRequest = (path: string, init: RequestInit) =>
          fetch(`${BASE_URL}/v1/admin/organizations/${org.id}${path}`, {
            ...init,
            headers: {
              Authorization: `Bearer ${adminToken}`,
              "Content-Type": "application/json",
            },
          });
        await adminRequest("", {
          method: "PATCH",
          body: JSON.stringify({ isActive: false }),
        });
        const archived = await adminRequest("/archive", { method: "POST" });
        expect(archived.status).toBe(HTTP_STATUS.NO_CONTENT);

        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id
        );

        const listing = (await (
          await getOrgSelect(sessionToken)
        ).json()) as OrgSelectGetResponse;
        expect(listing.organizations.map((o) => o.id)).not.toContain(org.id);

        const cookieName = `tereo_org_select_session_${testClient.clientId}`;
        const response = await fetch(`${BASE_URL}/oauth/org-select/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${cookieName}=${sessionToken}`,
          },
          body: JSON.stringify({
            session_token: sessionToken,
            organization_id: org.id,
          }),
        });

        const data = (await response.json()) as OrgSelectSubmitResponse;
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe("organization_not_active");
      });

      it("should successfully submit org selection with valid cookie", async () => {
        const org = await createTestOrganization(adminToken);
        await addTestOrgMember(adminToken, org.id, testUser.id);

        const { sessionToken } = await createOrgSelectSession(
          testUser.id,
          testClient.id
        );

        const cookieName = `tereo_org_select_session_${testClient.clientId}`;
        const response = await fetch(`${BASE_URL}/oauth/org-select/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `${cookieName}=${sessionToken}`,
          },
          body: JSON.stringify({
            session_token: sessionToken,
            organization_id: org.id,
          }),
          redirect: "manual",
        });

        const data = (await response.json()) as OrgSelectSubmitResponse;
        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.redirect_url).toBeDefined();
        expect(data.redirect_url).toContain("/consent");
        expect(data.redirect_url).toContain("session=");
      });
    });
  });
});
