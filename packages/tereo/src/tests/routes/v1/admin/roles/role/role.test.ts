// @module-tag int
// @module-tag auth

import { LOGIN_CLIENT } from "../../../../../../definitions/index.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestUser,
  createAdminUser,
  createTestRole,
  createTestPermission,
  getAccessTokenForUser,
} from "../../../../../support/auth.js";

interface RoleResponse {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  isSystem?: boolean;
  [key: string]: unknown;
}

interface RolesListResponse {
  data?: RoleResponse[];
  roles?: RoleResponse[];
  [key: string]: unknown;
}

let testRole: Awaited<ReturnType<typeof createTestRole>>;
let testPermission: Awaited<ReturnType<typeof createTestPermission>>;
let adminToken: string;

beforeAll(async () => {
  const adminUser = await createAdminUser();
  testRole = await createTestRole();
  testPermission = await createTestPermission();
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

describe("GET /v1/admin/roles/:id", () => {
  it("should get role by ID", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/roles/${testRole.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const data = (await response.json()) as RoleResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.id).toBe(testRole.id);
    expect(data.name).toBe(testRole.name);
  });

  it("should return 404 for non-existent role", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${NON_EXISTENT_UUID}`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe("PATCH /v1/admin/roles/:id", () => {
  it("should update role", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/roles/${testRole.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Updated Role Name" }),
    });

    const data = (await response.json()) as RoleResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.displayName).toBe("Updated Role Name");
  });

  it("should update role description", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/roles/${testRole.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "Updated description" }),
    });

    const data = (await response.json()) as RoleResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.description).toBe("Updated description");
  });

  it("should return 404 for non-existent role", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${NON_EXISTENT_UUID}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Test" }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe("PUT /v1/admin/roles/:id/permissions", () => {
  it("should set role permissions", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/permissions`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ permissionIds: [testPermission.id] }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  it("should replace existing permissions", async () => {
    // Create another permission
    const anotherPermission = await createTestPermission();

    // Set to new permission only
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/permissions`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ permissionIds: [anotherPermission.id] }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  it("should clear permissions with empty array", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/permissions`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ permissionIds: [] }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});

describe("DELETE /v1/admin/roles/:id", () => {
  it("should hard-delete role and cascade its assignments", async () => {
    const roleToDelete = await createTestRole();
    const permission = await createTestPermission();
    const user = await createTestUser();
    await prisma.rolePermission.create({
      data: { roleId: roleToDelete.id, permissionId: permission.id },
    });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: roleToDelete.id },
    });

    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${roleToDelete.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

    // Hard delete: the row and its join rows are gone
    const row = await prisma.role.findUnique({
      where: { id: roleToDelete.id },
    });
    expect(row).toBeNull();
    const rolePermissions = await prisma.rolePermission.findMany({
      where: { roleId: roleToDelete.id },
    });
    expect(rolePermissions).toEqual([]);
    const userRoles = await prisma.userRole.findMany({
      where: { roleId: roleToDelete.id },
    });
    expect(userRoles).toEqual([]);

    // The permission and user survive the cascade
    expect(
      await prisma.permission.findUnique({ where: { id: permission.id } })
    ).not.toBeNull();
    expect(
      await prisma.user.findUnique({ where: { id: user.id } })
    ).not.toBeNull();
  });

  it("should free the role name for reuse after delete", async () => {
    const roleToDelete = await createTestRole();

    const deleteResponse = await fetch(
      `${BASE_URL}/v1/admin/roles/${roleToDelete.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(deleteResponse.status).toBe(HTTP_STATUS.NO_CONTENT);

    const recreateResponse = await fetch(`${BASE_URL}/v1/admin/roles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: roleToDelete.name,
        displayName: "Recreated Role",
      }),
    });
    const recreated = (await recreateResponse.json()) as RoleResponse;
    expect(recreateResponse.status).toBe(HTTP_STATUS.CREATED);
    expect(recreated.name).toBe(roleToDelete.name);
    expect(recreated.id).not.toBe(roleToDelete.id);
  });

  it("should return 404 for non-existent role", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${NON_EXISTENT_UUID}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe("PUT /v1/admin/roles/:id/permissions - validation", () => {
  it("should return 400 for invalid permission IDs", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${testRole.id}/permissions`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ permissionIds: [999998, 999999] }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const error = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(
      /^Invalid request body\. permissionIds\.0: /
    );
  });

  it("accepts a repeated permission id once", async () => {
    const role = await createTestRole();
    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/permissions`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          permissionIds: [testPermission.id, testPermission.id],
        }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(
      await prisma.rolePermission.count({ where: { roleId: role.id } })
    ).toBe(1);
  });
});

describe("POST /v1/admin/roles/:id/archive and /restore", () => {
  async function deactivateRole(roleId: string) {
    const response = await fetch(`${BASE_URL}/v1/admin/roles/${roleId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isActive: false }),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
  }

  async function archiveRole(roleId: string, token = adminToken) {
    return fetch(`${BASE_URL}/v1/admin/roles/${roleId}/archive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function restoreRole(roleId: string, token = adminToken) {
    return fetch(`${BASE_URL}/v1/admin/roles/${roleId}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("should return 409 when archiving an active role", async () => {
    const role = await createTestRole();

    const response = await archiveRole(role.id);
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
  });

  it("should 409 (not 500) when creating a role with an archived role's name", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);
    await archiveRole(role.id);

    const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: role.name, displayName: "Clone" }),
    });
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    const body = (await response.json()) as { error_description: string };
    expect(body.error_description).toContain("archived");
  });

  it("should keep the read-only users list visible for an archived role", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);
    await archiveRole(role.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/users`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  it("should archive a deactivated role", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);

    const response = await archiveRole(role.id);
    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

    // GET by id stays readable and exposes archivedAt
    const getResponse = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const data = (await getResponse.json()) as RoleResponse;
    expect(getResponse.status).toBe(HTTP_STATUS.OK);
    expect(data.archivedAt).not.toBeNull();
    expect(data.isActive).toBe(false);
  });

  it("should hide archived roles from the list unless includeArchived=true", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);
    await archiveRole(role.id);

    const filter = `filter[name]=${role.name}&filter[name_op]=equals`;

    const hidden = await fetch(`${BASE_URL}/v1/admin/roles?${filter}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const hiddenData = (await hidden.json()) as RolesListResponse;
    expect(hidden.status).toBe(HTTP_STATUS.OK);
    expect(hiddenData.data).toEqual([]);

    const shown = await fetch(
      `${BASE_URL}/v1/admin/roles?includeArchived=true&${filter}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    const shownData = (await shown.json()) as RolesListResponse;
    expect(shown.status).toBe(HTTP_STATUS.OK);
    expect((shownData.data ?? []).map((r) => r.id)).toContain(role.id);
  });

  it("should return 409 for mutations on an archived role", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);
    await archiveRole(role.id);

    const patchResponse = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Should Not Apply" }),
    });
    expect(patchResponse.status).toBe(HTTP_STATUS.CONFLICT);

    const permissionsResponse = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/permissions`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ permissionIds: [testPermission.id] }),
      }
    );
    expect(permissionsResponse.status).toBe(HTTP_STATUS.CONFLICT);

    const removeUserResponse = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/users/${crypto.randomUUID()}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(removeUserResponse.status).toBe(HTTP_STATUS.CONFLICT);
    const removeUserData = (await removeUserResponse.json()) as {
      error?: string;
    };
    expect(removeUserData.error).toBe("resource_archived");
  });

  it("should restore an archived role still deactivated", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);
    await archiveRole(role.id);

    const response = await restoreRole(role.id);
    const data = (await response.json()) as RoleResponse;
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.id).toBe(role.id);
    expect(data.archivedAt).toBeNull();
    // Restore never reactivates — that's an explicit separate step
    expect(data.isActive).toBe(false);
  });

  it("should return 409 not_archived when restoring a non-archived role", async () => {
    const role = await createTestRole();

    const response = await restoreRole(role.id);
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toBe("not_archived");
  });

  it("should return 409 already_archived when archiving an archived role", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);
    expect((await archiveRole(role.id)).status).toBe(HTTP_STATUS.NO_CONTENT);

    const response = await archiveRole(role.id);
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toBe("already_archived");
  });

  it("should allow hard delete of an archived role", async () => {
    const role = await createTestRole();
    await deactivateRole(role.id);
    await archiveRole(role.id);

    const response = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

    const row = await prisma.role.findUnique({ where: { id: role.id } });
    expect(row).toBeNull();
  });
});
