import { DEFAULT_ORGANIZATION_ID } from "../../definitions/index.js";
import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createTestUser,
  createAdminUser,
  createTestRole,
  getAccessTokenForUser,
  generateUniqueId,
  createTestOrganization,
  addTestOrgMember,
} from "./utils/test-helpers.js";
import type {
  OrganizationResponse,
  OrganizationListResponse,
  OrganizationMembersResponse,
  OrganizationMemberResponse,
  MemberRolesResponse,
} from "./utils/test-helpers.js";

describe("Admin Organizations Endpoints", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
  let regularUser: Awaited<ReturnType<typeof createTestUser>>;
  let adminToken: string;
  let regularToken: string;

  beforeAll(async () => {
    testClient = await createTestClient();
    adminUser = await createAdminUser();
    regularUser = await createTestUser();

    adminToken = await getAccessTokenForUser(adminUser, testClient);
    regularToken = await getAccessTokenForUser(regularUser, testClient);
  });

  // ===========================================================================
  // Organization CRUD
  // ===========================================================================

  describe("POST /admin/organizations", () => {
    it("should create an organization", async () => {
      const uniqueId = generateUniqueId();
      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `Test Org ${uniqueId}`,
          slug: `test-org-${uniqueId}`,
          code: uniqueId.slice(0, 6).toUpperCase(),
        }),
      });

      const data = (await response.json()) as OrganizationResponse;
      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.id).toBeDefined();
      expect(data.name).toBe(`Test Org ${uniqueId}`);
      expect(data.slug).toBe(`test-org-${uniqueId}`);
      expect(data.isActive).toBe(true);
      expect(data.isDefault).toBe(false);
      expect(data.memberCount).toBe(0);
    });

    it("should return 409 for duplicate slug", async () => {
      const org = await createTestOrganization(adminToken);

      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Different Name",
          slug: org.slug,
          code: generateUniqueId().slice(0, 6).toUpperCase(),
        }),
      });

      const data = (await response.json()) as { error?: string };
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      expect(data.error).toBe("slug_taken");
    });

    it("should return 409 for duplicate code", async () => {
      const code = generateUniqueId().slice(0, 6).toUpperCase();
      await createTestOrganization(adminToken, { code });

      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Different Name",
          slug: `test-org-${generateUniqueId()}`,
          code,
        }),
      });

      const data = (await response.json()) as { error?: string };
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      expect(data.error).toBe("code_taken");
    });

    it("should return 400 for invalid slug format", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test",
          slug: "INVALID_SLUG!",
          code: "ABC",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 400 for invalid code format", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test",
          slug: `valid-slug-${generateUniqueId()}`,
          code: "toolong1",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 401 without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          slug: "test",
          code: "TST",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 403 for non-admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${regularToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test",
          slug: `test-${generateUniqueId()}`,
          code: "TST",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("GET /admin/organizations", () => {
    it("should list organizations with admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const data = (await response.json()) as OrganizationListResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(Array.isArray(data.data)).toBe(true);
      expect(typeof data.hasMore).toBe("boolean");
      expect(typeof data.limit).toBe("number");
      expect(data).toHaveProperty("nextCursor");
    });

    it("filters by isActive", async () => {
      const active = await createTestOrganization(adminToken);
      const inactive = await createTestOrganization(adminToken);
      await prisma.organization.update({
        where: { id: inactive.id },
        data: { isActive: false },
      });

      const list = async (slug: string, isActive: string) => {
        const response = await fetch(
          `${BASE_URL}/v1/admin/organizations?filter[isActive]=${isActive}` +
            `&filter[slug]=${slug}&filter[slug_op]=equals`,
          { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        expect(response.status).toBe(HTTP_STATUS.OK);
        const data = (await response.json()) as OrganizationListResponse;
        return data.data.map((o) => o.id);
      };

      expect(await list(active.slug, "true")).toEqual([active.id]);
      expect(await list(active.slug, "false")).toEqual([]);
      expect(await list(inactive.slug, "false")).toEqual([inactive.id]);
      expect(await list(inactive.slug, "true")).toEqual([]);
    });

    it("should support cursor pagination", async () => {
      // Ensure at least 3 orgs exist for a meaningful page break
      await createTestOrganization(adminToken);
      await createTestOrganization(adminToken);
      await createTestOrganization(adminToken);

      const firstPage = await fetch(
        `${BASE_URL}/v1/admin/organizations?limit=2`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const firstData = (await firstPage.json()) as OrganizationListResponse;
      expect(firstPage.status).toBe(HTTP_STATUS.OK);
      expect(firstData.data.length).toBe(2);
      expect(firstData.hasMore).toBe(true);
      expect(firstData.nextCursor).toBeTruthy();

      const secondPage = await fetch(
        `${BASE_URL}/v1/admin/organizations?limit=2&cursor=${encodeURIComponent(
          firstData.nextCursor as string
        )}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );

      const secondData = (await secondPage.json()) as OrganizationListResponse;
      expect(secondPage.status).toBe(HTTP_STATUS.OK);
      expect(secondData.data.length).toBeGreaterThan(0);

      // No overlap between pages
      const firstIds = new Set(firstData.data.map((o) => o.id));
      for (const o of secondData.data) {
        expect(firstIds.has(o.id)).toBe(false);
      }
    });

    it("should return 400 for tampered cursor", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations?limit=2&cursor=not-a-real-cursor`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("invalid_cursor");
    });

    it("should return 401 without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/organizations`);
      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 403 for non-admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        headers: { Authorization: `Bearer ${regularToken}` },
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("GET /admin/organizations/:id", () => {
    it("should get organization by id", async () => {
      const org = await createTestOrganization(adminToken);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );

      const data = (await response.json()) as OrganizationResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id).toBe(org.id);
      expect(data.name).toBe(org.name);
      expect(data.slug).toBe(org.slug);
    });

    it("should return 404 for non-existent organization", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${NON_EXISTENT_UUID}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 401 without auth token", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${NON_EXISTENT_UUID}`
      );
      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("PATCH /admin/organizations/:id", () => {
    it("should update organization name", async () => {
      const org = await createTestOrganization(adminToken);
      const newName = `Updated Org ${generateUniqueId()}`;

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: newName }),
        }
      );

      const data = (await response.json()) as OrganizationResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.name).toBe(newName);
    });

    it("should update organization slug", async () => {
      const org = await createTestOrganization(adminToken);
      const newSlug = `updated-slug-${generateUniqueId()}`;

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slug: newSlug }),
        }
      );

      const data = (await response.json()) as OrganizationResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.slug).toBe(newSlug);
    });

    it("should return 409 when updating slug to existing slug", async () => {
      const org1 = await createTestOrganization(adminToken);
      const org2 = await createTestOrganization(adminToken);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org2.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ slug: org1.slug }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("should deactivate organization", async () => {
      const org = await createTestOrganization(adminToken);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        }
      );

      const data = (await response.json()) as OrganizationResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.isActive).toBe(false);
    });

    it("should return 404 for non-existent organization", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${NON_EXISTENT_UUID}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Updated" }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("DELETE /admin/organizations/:id", () => {
    // Organizations are archived, never deleted — audit history, buckets and
    // webhook endpoints reference them.
    it("is not routed", async () => {
      const org = await createTestOrganization(adminToken);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const row = await prisma.organization.findUnique({
        where: { id: org.id },
      });
      expect(row).not.toBeNull();
    });
  });

  // ===========================================================================
  // Archive / Restore
  // ===========================================================================

  describe("POST /admin/organizations/:id/archive and /restore", () => {
    async function deactivateOrg(orgId: string) {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${orgId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
    }

    async function archiveOrg(orgId: string, token = adminToken) {
      return fetch(`${BASE_URL}/v1/admin/organizations/${orgId}/archive`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    async function restoreOrg(orgId: string, token = adminToken) {
      return fetch(`${BASE_URL}/v1/admin/organizations/${orgId}/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    it("should 409 (not 500) when creating an organization with an archived org's slug", async () => {
      const org = await createTestOrganization(adminToken);
      await deactivateOrg(org.id);
      await archiveOrg(org.id);

      const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Clone Org",
          slug: org.slug,
          code: `C${Date.now().toString(36).slice(-5).toUpperCase()}`,
        }),
      });
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      const body = (await response.json()) as { error_description: string };
      expect(body.error_description).toContain("archived");
    });

    it("should keep the read-only member list visible for an archived org", async () => {
      const org = await createTestOrganization(adminToken);
      await deactivateOrg(org.id);
      await archiveOrg(org.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
    });

    it("should keep a member's org roles readable for an archived org", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);
      const role = await createTestRole();
      const put = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [role.id] }),
        }
      );
      expect(put.status).toBe(HTTP_STATUS.OK);
      await deactivateOrg(org.id);
      await archiveOrg(org.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
      const data = (await response.json()) as MemberRolesResponse;
      expect(data.roles.map((r) => r.id)).toEqual([role.id]);

      const mutate = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [] }),
        }
      );
      expect(mutate.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("should return 409 when archiving an active organization", async () => {
      const org = await createTestOrganization(adminToken);

      const response = await archiveOrg(org.id);
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("should archive a deactivated organization", async () => {
      const org = await createTestOrganization(adminToken);
      await deactivateOrg(org.id);

      const response = await archiveOrg(org.id);
      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

      // GET by id stays readable and exposes archivedAt
      const getResponse = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      const data = (await getResponse.json()) as OrganizationResponse;
      expect(getResponse.status).toBe(HTTP_STATUS.OK);
      expect(data.archivedAt).not.toBeNull();
      expect(data.isActive).toBe(false);
    });

    it("should hide archived organizations from the list unless includeArchived=true", async () => {
      const org = await createTestOrganization(adminToken);
      await deactivateOrg(org.id);
      await archiveOrg(org.id);

      const filter = `filter[slug]=${org.slug}&filter[slug_op]=equals`;

      const hidden = await fetch(
        `${BASE_URL}/v1/admin/organizations?${filter}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      const hiddenData = (await hidden.json()) as OrganizationListResponse;
      expect(hidden.status).toBe(HTTP_STATUS.OK);
      expect(hiddenData.data).toEqual([]);

      const shown = await fetch(
        `${BASE_URL}/v1/admin/organizations?includeArchived=true&${filter}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      const shownData = (await shown.json()) as OrganizationListResponse;
      expect(shown.status).toBe(HTTP_STATUS.OK);
      expect(shownData.data.map((o) => o.id)).toContain(org.id);
    });

    it("should return 409 when updating an archived organization", async () => {
      const org = await createTestOrganization(adminToken);
      await deactivateOrg(org.id);
      await archiveOrg(org.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Should Not Apply" }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("should return 409 for member mutations on an archived organization", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await deactivateOrg(org.id);
      await archiveOrg(org.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: user.id }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("should restore an archived organization still deactivated", async () => {
      const org = await createTestOrganization(adminToken);
      await deactivateOrg(org.id);
      await archiveOrg(org.id);

      const response = await restoreOrg(org.id);
      const data = (await response.json()) as OrganizationResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id).toBe(org.id);
      expect(data.archivedAt).toBeNull();
      // Restore never reactivates — that's an explicit separate step
      expect(data.isActive).toBe(false);
    });

    it("should return 409 not_archived when restoring a non-archived organization", async () => {
      const org = await createTestOrganization(adminToken);

      const response = await restoreOrg(org.id);
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("not_archived");
    });

    it("should return 409 already_archived when archiving an archived organization", async () => {
      const org = await createTestOrganization(adminToken);
      await deactivateOrg(org.id);
      expect((await archiveOrg(org.id)).status).toBe(HTTP_STATUS.NO_CONTENT);

      const response = await archiveOrg(org.id);
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("already_archived");
    });

    it("should return 400 when archiving the default organization", async () => {
      const defaultOrg = await prisma.organization.findFirst({
        where: { isDefault: true },
      });
      expect(defaultOrg).not.toBeNull();

      const response = await archiveOrg(defaultOrg!.id);
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("default_organization");
    });

    it("should return 403 for archive without permission", async () => {
      const org = await createTestOrganization(adminToken);
      await deactivateOrg(org.id);

      const response = await archiveOrg(org.id, regularToken);
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should return 403 (not 409) for unauthorized callers on live and archived organizations alike", async () => {
      const liveOrg = await createTestOrganization(adminToken);
      const archivedOrg = await createTestOrganization(adminToken);
      await deactivateOrg(archivedOrg.id);
      await archiveOrg(archivedOrg.id);

      // regularUser is neither a platform admin nor a member of either org.
      // Same status for both ids — an unauthorized caller must not be able
      // to distinguish archived rows (409) from live ones (403).
      for (const id of [liveOrg.id, archivedOrg.id]) {
        const response = await fetch(
          `${BASE_URL}/v1/admin/organizations/${id}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${regularToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "Should Not Apply" }),
          }
        );
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      }
    });

    it("should return 404 when archiving a non-existent organization", async () => {
      const response = await archiveOrg(NON_EXISTENT_UUID);
      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  // ===========================================================================
  // Organization Members
  // ===========================================================================

  describe("POST /admin/organizations/:id/members", () => {
    it("should add a member with default role", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: user.id }),
        }
      );

      const data = (await response.json()) as OrganizationMemberResponse;
      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.memberRole).toBe("member");
      expect(data.user.id).toBe(user.id);

      const entry = await prisma.auditLogEntry.findFirst({
        where: { entityType: "OrganizationMember", entityId: data.id },
      });
      expect(entry).toMatchObject({
        action: "CREATE",
        organizationId: org.id,
        userId: adminUser.id,
        entityName: user.email,
        metadata: { userId: user.id, memberRole: "member" },
      });
    });

    it("should return 400 unknown_user for a userId that names no user", async () => {
      const org = await createTestOrganization(adminToken);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: randomUUID() }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("unknown_user");
    });

    it("should add a member with owner role", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: user.id, memberRole: "owner" }),
        }
      );

      const data = (await response.json()) as OrganizationMemberResponse;
      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.memberRole).toBe("owner");
    });

    it("should return 409 when user is already a member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: user.id }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("should return 404 for non-existent organization", async () => {
      const user = await createTestUser();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${NON_EXISTENT_UUID}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: user.id }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 400 for invalid memberRole", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userId: user.id, memberRole: "superadmin" }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("GET /admin/organizations/:id/members", () => {
    it("should list members of an organization", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );

      const data = (await response.json()) as OrganizationMembersResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.organizationId).toBe(org.id);
      expect(Array.isArray(data.members)).toBe(true);
      expect(data.members.length).toBeGreaterThanOrEqual(1);
    });

    it("should return 404 for non-existent organization", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${NON_EXISTENT_UUID}/members`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("PATCH /admin/organizations/:id/members/:userId", () => {
    it("should update member role", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id, "member");

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ memberRole: "admin" }),
        }
      );

      const data = (await response.json()) as OrganizationMemberResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.memberRole).toBe("admin");

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityType: "OrganizationMember",
          entityId: data.id,
          action: "UPDATE",
        },
      });
      expect(entry).toMatchObject({
        organizationId: org.id,
        userId: adminUser.id,
        changes: { memberRole: { old: "member", new: "admin" } },
        metadata: { userId: user.id },
      });
    });

    it("should return 404 when user is not a member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ memberRole: "admin" }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 400 for invalid memberRole", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ memberRole: "invalid" }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 403 when caller is neither platform admin nor org member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${regularToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ memberRole: "admin" }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should return 403 when an org admin tries to change an owner's role", async () => {
      const org = await createTestOrganization(adminToken);
      const owner = await createTestUser();
      const orgAdmin = await createTestUser();
      await addTestOrgMember(adminToken, org.id, owner.id, "owner");
      await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
      const orgAdminToken = await getAccessTokenForUser(orgAdmin, testClient);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${orgAdminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ memberRole: "member" }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should return 403 when an org admin tries to make anyone an owner, themselves included", async () => {
      const org = await createTestOrganization(adminToken);
      const member = await createTestUser();
      const orgAdmin = await createTestUser();
      await addTestOrgMember(adminToken, org.id, member.id);
      await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
      const orgAdminToken = await getAccessTokenForUser(orgAdmin, testClient);

      for (const target of [member.id, orgAdmin.id]) {
        const response = await fetch(
          `${BASE_URL}/v1/admin/organizations/${org.id}/members/${target}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${orgAdminToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ memberRole: "owner" }),
          }
        );
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      }

      const added = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${orgAdminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: (await createTestUser()).id,
            memberRole: "owner",
          }),
        }
      );
      expect(added.status).toBe(HTTP_STATUS.FORBIDDEN);

      const roles = await prisma.organizationMember.findMany({
        where: { organizationId: org.id },
        select: { memberRole: true },
      });
      expect(roles.map((r) => r.memberRole).sort()).toEqual([
        "admin",
        "member",
      ]);
    });

    it("should return 409 when demoting the last owner", async () => {
      const org = await createTestOrganization(adminToken);
      const owner = await createTestUser();
      await addTestOrgMember(adminToken, org.id, owner.id, "owner");

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ memberRole: "admin" }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("emits auth.organization.member-updated", async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.organization.member-updated"] }
      );
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      const member = await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ memberRole: "admin" }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);

      const where = {
        webhookEndpointId: endpoint.id,
        eventType: "auth.organization.member-updated",
        payload: { path: ["entityId"], equals: member.id },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
    });
  });

  describe("DELETE /admin/organizations/:id/members/:userId", () => {
    it("should remove a member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      const member = await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityType: "OrganizationMember",
          entityId: member.id,
          action: "DELETE",
        },
      });
      expect(entry).toMatchObject({
        organizationId: org.id,
        userId: adminUser.id,
        entityName: user.email,
        metadata: { userId: user.id, memberRole: "member" },
      });
    });

    it("should return 404 when user is not a member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 401 without authentication", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        { method: "DELETE" }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 403 when caller is neither platform admin nor org member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should return 403 when caller is only an org member", async () => {
      const org = await createTestOrganization(adminToken);
      const target = await createTestUser();
      const plainMember = await createTestUser();
      await addTestOrgMember(adminToken, org.id, target.id);
      await addTestOrgMember(adminToken, org.id, plainMember.id, "member");
      const memberToken = await getAccessTokenForUser(plainMember, testClient);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${target.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${memberToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should return 403 when an org admin tries to remove an owner", async () => {
      const org = await createTestOrganization(adminToken);
      const owner = await createTestUser();
      const orgAdmin = await createTestUser();
      await addTestOrgMember(adminToken, org.id, owner.id, "owner");
      await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
      const orgAdminToken = await getAccessTokenForUser(orgAdmin, testClient);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${orgAdminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should return 409 when removing the last owner", async () => {
      const org = await createTestOrganization(adminToken);
      const owner = await createTestUser();
      await addTestOrgMember(adminToken, org.id, owner.id, "owner");

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      expect(
        await prisma.organizationMember.count({
          where: { organizationId: org.id, userId: owner.id },
        })
      ).toBe(1);
    });

    it("two concurrent removals of the last two owners: one is refused", async () => {
      const org = await createTestOrganization(adminToken);
      const owners = [await createTestUser(), await createTestUser()];
      for (const owner of owners) {
        await addTestOrgMember(adminToken, org.id, owner.id, "owner");
      }

      const responses = await Promise.all(
        owners.map((owner) =>
          fetch(
            `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${adminToken}` },
            }
          )
        )
      );
      expect(responses.map((r) => r.status).sort()).toEqual([
        HTTP_STATUS.NO_CONTENT,
        HTTP_STATUS.CONFLICT,
      ]);
      expect(
        await prisma.organizationMember.count({
          where: { organizationId: org.id, memberRole: "owner" },
        })
      ).toBe(1);
    });

    it("drops the member's org-scoped roles with the membership", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);
      const role = await createTestRole();
      const put = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [role.id] }),
        }
      );
      expect(put.status).toBe(HTTP_STATUS.OK);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
      expect(
        await prisma.userRole.count({
          where: { userId: user.id, organizationId: org.id },
        })
      ).toBe(0);
    });

    it("should allow an org admin without platform permissions to remove a member", async () => {
      const org = await createTestOrganization(adminToken);
      const target = await createTestUser();
      const orgAdmin = await createTestUser();
      await addTestOrgMember(adminToken, org.id, target.id);
      await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
      const orgAdminToken = await getAccessTokenForUser(orgAdmin, testClient);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${target.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${orgAdminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
    });
  });

  // ===========================================================================
  // Organization Member Roles
  // ===========================================================================

  describe("GET /admin/organizations/:id/members/:userId/roles", () => {
    it("should return empty roles for a member with no org-scoped roles", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );

      const data = (await response.json()) as MemberRolesResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.organizationId).toBe(org.id);
      expect(data.userId).toBe(user.id);
      expect(data.roles).toEqual([]);
    });

    it("should return 404 not_found when user is not a member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("not_found");
    });
  });

  describe("PUT /admin/organizations/:id/members/:userId/roles", () => {
    it("should set roles for a member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);
      const role = await createTestRole();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [role.id] }),
        }
      );

      const data = (await response.json()) as MemberRolesResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.roles.length).toBe(1);
      expect(data.roles[0].id).toBe(role.id);

      const membership = await prisma.organizationMember.findUniqueOrThrow({
        where: {
          organizationId_userId: { organizationId: org.id, userId: user.id },
        },
      });
      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityType: "OrganizationMember",
          entityId: membership.id,
          action: "UPDATE",
        },
      });
      expect(entry).toMatchObject({
        organizationId: org.id,
        userId: adminUser.id,
        entityName: user.email,
        metadata: {
          action: "roles_changed",
          userId: user.id,
          roleIds: [role.id],
        },
      });
    });

    it("should ignore duplicate role ids", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);
      const role = await createTestRole();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [role.id, role.id] }),
        }
      );

      const data = (await response.json()) as MemberRolesResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.roles.map((r) => r.id)).toEqual([role.id]);
    });

    it("should clear roles with empty array", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);
      const role = await createTestRole();

      // Set a role first
      await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [role.id] }),
        }
      );

      // Clear roles
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [] }),
        }
      );

      const data = (await response.json()) as MemberRolesResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.roles).toEqual([]);
    });

    it("should return 400 for non-existent role IDs", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [999999] }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 400 unknown_role for a role id that names no role", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      await addTestOrgMember(adminToken, org.id, user.id);

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [randomUUID()] }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("unknown_role");
    });

    it("should return 404 not_found when user is not a member", async () => {
      const org = await createTestOrganization(adminToken);
      const user = await createTestUser();
      const role = await createTestRole();

      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [role.id] }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("not_found");
    });

    describe("granted by an org admin", () => {
      let org: OrganizationResponse;
      let member: Awaited<ReturnType<typeof createTestUser>>;
      let orgAdminToken: string;

      const roleWith = async (permission: string) => {
        const role = await createTestRole();
        const { id: permissionId } = await prisma.permission.findUniqueOrThrow({
          where: { name: permission },
        });
        await prisma.rolePermission.create({
          data: { roleId: role.id, permissionId },
        });
        return role;
      };

      const put = (roleIds: string[]) =>
        fetch(
          `${BASE_URL}/v1/admin/organizations/${org.id}/members/${member.id}/roles`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${orgAdminToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ roleIds }),
          }
        );

      beforeAll(async () => {
        org = await createTestOrganization(adminToken);
        member = await createTestUser();
        const orgAdmin = await createTestUser();
        await addTestOrgMember(adminToken, org.id, member.id);
        await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
        // Holds users.read and webhooks.read and nothing else.
        orgAdminToken = await getTestPrincipalToken({
          userId: orgAdmin.id,
          permissions: ["users.read", "webhooks.read"],
        });
      });

      it("refuses a system role", async () => {
        const role = await createTestRole({ isSystem: true });
        const response = await put([role.id]);
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("refuses a custom role granting admin", async () => {
        const role = await roleWith("admin");
        const response = await put([role.id]);
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const data = (await response.json()) as { error?: string };
        expect(data.error).toBe("not_org_assignable");
        expect(JSON.stringify(data)).toContain("admin");
        expect(
          await prisma.userRole.count({
            where: { userId: member.id, organizationId: org.id },
          })
        ).toBe(0);
      });

      it("refuses a custom role granting a permission the caller lacks", async () => {
        const role = await roleWith("webhooks.write");
        const response = await put([role.id]);
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("refuses a permission that is not org-assignable, even one the caller holds", async () => {
        const role = await roleWith("users.read");
        const response = await put([role.id]);
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(((await response.json()) as { error: string }).error).toBe(
          "not_org_assignable"
        );
      });

      it("allows a role whose permissions the caller holds", async () => {
        const role = await roleWith("webhooks.read");
        const response = await put([role.id]);
        expect(response.status).toBe(HTTP_STATUS.OK);
      });

      it("refuses a permission the caller holds only through another organization's role", async () => {
        // Admin in `org`, holding webhooks.write only through a role in
        // another organization, and acting with a token for that one.
        const otherOrg = await createTestOrganization(adminToken);
        const crossAdmin = await createTestUser();
        await addTestOrgMember(adminToken, org.id, crossAdmin.id, "admin");
        await addTestOrgMember(adminToken, otherOrg.id, crossAdmin.id);
        await prisma.userRole.create({
          data: {
            userId: crossAdmin.id,
            roleId: (await roleWith("webhooks.write")).id,
            organizationId: otherOrg.id,
          },
        });
        const otherOrgToken = await getTestPrincipalToken({
          userId: crossAdmin.id,
          organizationId: otherOrg.id,
          permissions: [],
        });

        const role = await roleWith("webhooks.write");
        const response = await fetch(
          `${BASE_URL}/v1/admin/organizations/${org.id}/members/${member.id}/roles`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${otherOrgToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ roleIds: [role.id] }),
          }
        );
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(
          await prisma.userRole.count({
            where: { userId: member.id, roleId: role.id },
          })
        ).toBe(0);
      });

      it("refuses an org admin changing an owner's roles, and lets an owner", async () => {
        const owner = await createTestUser();
        await addTestOrgMember(adminToken, org.id, owner.id, "owner");
        const ownerToken = await getTestPrincipalToken({
          userId: owner.id,
          permissions: [],
        });
        const otherOwner = await createTestUser();
        await addTestOrgMember(adminToken, org.id, otherOwner.id, "owner");
        const role = await createTestRole();

        const putFor = (token: string) =>
          fetch(
            `${BASE_URL}/v1/admin/organizations/${org.id}/members/${otherOwner.id}/roles`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ roleIds: [role.id] }),
            }
          );

        expect((await putFor(orgAdminToken)).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
        expect(
          await prisma.userRole.count({
            where: { userId: otherOwner.id, organizationId: org.id },
          })
        ).toBe(0);
        expect((await putFor(ownerToken)).status).toBe(HTTP_STATUS.OK);
      });

      it("keeps a role a platform admin granted when changing others", async () => {
        const granted = await roleWith("webhooks.write");
        const byAdmin = await fetch(
          `${BASE_URL}/v1/admin/organizations/${org.id}/members/${member.id}/roles`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${adminToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ roleIds: [granted.id] }),
          }
        );
        expect(byAdmin.status).toBe(HTTP_STATUS.OK);

        const plain = await createTestRole();
        const response = await put([granted.id, plain.id]);
        expect(response.status).toBe(HTTP_STATUS.OK);
        const data = (await response.json()) as MemberRolesResponse;
        expect(data.roles.map((r) => r.id).sort()).toEqual(
          [granted.id, plain.id].sort()
        );
      });
    });
  });

  describe("default organization", () => {
    it("cannot be deactivated", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${DEFAULT_ORGANIZATION_ID}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("default_organization");

      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: DEFAULT_ORGANIZATION_ID },
      });
      expect(org.isActive).toBe(true);
    });
  });
});
