// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../../../support/principals.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  CORE_SERVICE_ID,
  LOGIN_CLIENT,
} from "../../../../../../../../definitions/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestUser,
  createAdminUser,
  createTestRole,
  createTestOrganization,
  addTestOrgMember,
  getAccessTokenForUser,
} from "../../../../../../../support/auth.js";

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let regularUser: Awaited<ReturnType<typeof createTestUser>>;
let testRole: Awaited<ReturnType<typeof createTestRole>>;
let adminToken: string;

beforeAll(async () => {
  const adminUser = await createAdminUser();
  regularUser = await createTestUser();
  testRole = await createTestRole();
  // Through core's UI: a delegated token could not grant the test
  // service's permissions, which no core scope's ceiling covers.
  adminToken = await getAccessTokenForUser(
    adminUser,
    await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    }),
    "openid profile email"
  );
});

describe("DELETE /v1/admin/roles/:id/users/:userId", () => {
  it("should return 204 when removing role from user", async () => {
    // First, assign role to a user
    const userResponse = await fetch(
      `${BASE_URL}/v1/admin/users/${regularUser.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [testRole.id] }),
      }
    );

    expect(userResponse.status).toBe(HTTP_STATUS.OK);

    // Now remove the role
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/users/${regularUser.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
  });

  it("should return 404 for non-existent role", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${NON_EXISTENT_UUID}/users/${regularUser.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("should return 404 for non-existent user", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/users/${NON_EXISTENT_UUID}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe("DELETE /v1/admin/roles/:id/users/:userId?organizationId", () => {
  const setUp = async () => {
    const user = await createTestUser();
    const org = await createTestOrganization(adminToken);
    await addTestOrgMember(adminToken, org.id, user.id);
    const role = await createTestRole();
    await prisma.userRole.createMany({
      data: [
        { userId: user.id, roleId: role.id },
        { userId: user.id, roleId: role.id, organizationId: org.id },
      ],
    });
    return { user, org, role };
  };
  const remove = (
    token: string,
    roleId: string,
    userId: string,
    organizationId?: string
  ) =>
    fetch(
      `${BASE_URL}/v1/admin/roles/${roleId}/users/${userId}${
        organizationId ? `?organizationId=${organizationId}` : ""
      }`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );
  const scopes = async (userId: string, roleId: string) =>
    (await prisma.userRole.findMany({ where: { userId, roleId } })).map(
      (ur) => ur.organizationId
    );

  it("removes the org-scoped row the role's user list shows, leaving the global one", async () => {
    const { user, org, role } = await setUp();

    const listed = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const { users } = (await listed.json()) as {
      users: { id: string; organizationId: string | null }[];
    };
    const orgRow = users.find((u) => u.organizationId === org.id)!;
    expect(orgRow.id).toBe(user.id);

    const res = await remove(adminToken, role.id, orgRow.id, org.id);
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(await scopes(user.id, role.id)).toEqual([null]);

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        entityType: "RoleAssignment",
        entityId: `${role.id}:${user.id}:${org.id}`,
      },
    });
    expect(entry.action).toBe("DELETE");
    expect(entry.organizationId).toBe(org.id);
    expect(entry.metadata).toMatchObject({ organizationId: org.id });

    // A second removal finds nothing; the global row is still removable.
    expect((await remove(adminToken, role.id, user.id, org.id)).status).toBe(
      HTTP_STATUS.NOT_FOUND
    );
    expect((await remove(adminToken, role.id, user.id)).status).toBe(
      HTTP_STATUS.NO_CONTENT
    );
    expect(await scopes(user.id, role.id)).toEqual([]);
  });

  it("needs organization authority for an org-scoped row, not for the global one", async () => {
    const { user, org, role } = await setUp();
    const rolesOnly = await getTestPrincipalToken({
      permissions: ["roles.delete"],
    });

    const res = await remove(rolesOnly, role.id, user.id, org.id);
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect((await remove(rolesOnly, role.id, user.id)).status).toBe(
      HTTP_STATUS.NO_CONTENT
    );
    expect(await scopes(user.id, role.id)).toEqual([org.id]);
  });

  it("rejects an organizationId that is not a uuid", async () => {
    const { user, role } = await setUp();
    const res = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/users/${user.id}?organizationId=nope`,
      { method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` } }
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const error = (await res.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(
      /^Invalid request query\. organizationId: /
    );
  });

  it("removes an org-scoped admin grant, which never kept core administrable", async () => {
    const adminRole = await prisma.role.findFirstOrThrow({
      where: { name: "admin", serviceId: CORE_SERVICE_ID },
    });
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    await prisma.userRole.create({
      data: { userId: user.id, roleId: adminRole.id, organizationId: org.id },
    });

    expect(
      (await remove(adminToken, adminRole.id, user.id, org.id)).status
    ).toBe(HTTP_STATUS.NO_CONTENT);
    expect(await scopes(user.id, adminRole.id)).toEqual([]);
  });
});
