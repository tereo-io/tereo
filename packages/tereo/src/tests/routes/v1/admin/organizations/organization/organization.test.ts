// @module-tag int
// @module-tag auth

import { DEFAULT_ORGANIZATION_ID } from "../../../../../../definitions/index.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
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
  type OrganizationResponse,
  type OrganizationListResponse,
  type MemberRolesResponse,
} from "../../../../../support/auth.js";

let adminToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("GET /v1/admin/organizations/:id", () => {
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

describe("PATCH /v1/admin/organizations/:id", () => {
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

describe("DELETE /v1/admin/organizations/:id", () => {
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

describe("POST /v1/admin/organizations/:id/archive and /restore", () => {
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

    const hidden = await fetch(`${BASE_URL}/v1/admin/organizations?${filter}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
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

  it("should return 404 when archiving a non-existent organization", async () => {
    const response = await archiveOrg(NON_EXISTENT_UUID);
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
