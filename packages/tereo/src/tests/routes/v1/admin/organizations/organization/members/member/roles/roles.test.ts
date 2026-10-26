// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../../../../support/auth/clients.js";
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestOrganization,
  addTestOrgMember,
  type MemberRolesResponse,
} from "../../../../../../../../support/auth/organizations.js";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../../../../support/auth/constants.js";
import {
  createTestUser,
  createAdminUser,
  createTestRole,
} from "../../../../../../../../support/auth/users.js";

let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
let adminToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  adminUser = await createAdminUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("GET /v1/admin/organizations/:id/members/:userId/roles", () => {
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

describe("PUT /v1/admin/organizations/:id/members/:userId/roles", () => {
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
    const error = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(
      /^Invalid request body\. roleIds\.0: /
    );
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
});
