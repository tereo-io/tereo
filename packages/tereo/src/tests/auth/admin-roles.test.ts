import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { makeServiceOf } from "../utils/testService.js";
import { browserLogin } from "../utils/browserLogin.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  CORE_SERVICE_ID,
  DEFAULT_ORGANIZATION_ID,
  LOGIN_CLIENT,
} from "../../definitions/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  checkUserPermission,
  createTestClient,
  createTestUser,
  createAdminUser,
  createTestRole,
  createTestPermission,
  createTestOrganization,
  addTestOrgMember,
  decodeJwt,
  getAccessTokenForUser,
  generateUniqueId,
} from "./utils/test-helpers.js";

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

interface RoleUsersResponse {
  roleId: string;
  users: Array<{ id: string; email: string; name?: string }>;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

describe("Admin Roles Endpoints", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
  let regularUser: Awaited<ReturnType<typeof createTestUser>>;
  let adminToken: string;
  let regularToken: string;
  let testRole: Awaited<ReturnType<typeof createTestRole>>;
  let testPermission: Awaited<ReturnType<typeof createTestPermission>>;

  beforeAll(async () => {
    testClient = await createTestClient();
    adminUser = await createAdminUser();
    regularUser = await createTestUser();
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
    regularToken = await getAccessTokenForUser(regularUser, testClient);
  });

  describe("GET /admin/roles", () => {
    it("should list roles with admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const data = (await response.json()) as RolesListResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      // Response uses "data" key for the array
      expect(Array.isArray(data.data || data.roles)).toBe(true);
    });

    it("should return 401 with error for request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/roles`);

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 with error for request with non-admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
        headers: { Authorization: `Bearer ${regularToken}` },
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("filters by isActive", async () => {
      const inactive = await createTestRole();
      await prisma.role.update({
        where: { id: inactive.id },
        data: { isActive: false },
      });

      const list = async (name: string, isActive: string) => {
        const response = await fetch(
          `${BASE_URL}/v1/admin/roles?filter[isActive]=${isActive}` +
            `&filter[name]=${name}&filter[name_op]=equals`,
          { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        expect(response.status).toBe(HTTP_STATUS.OK);
        const data = (await response.json()) as RolesListResponse;
        return (data.data ?? []).map((r) => r.id);
      };

      expect(await list(testRole.name, "true")).toEqual([testRole.id]);
      expect(await list(testRole.name, "false")).toEqual([]);
      expect(await list(inactive.name, "false")).toEqual([inactive.id]);
      expect(await list(inactive.name, "true")).toEqual([]);
    });
  });

  describe("POST /admin/roles", () => {
    it("should create a new role", async () => {
      const uniqueId = generateUniqueId();
      const newRoleData = {
        name: `new-role-${uniqueId}`,
        displayName: `New Role ${uniqueId}`,
        description: "A newly created test role",
      };

      const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(newRoleData),
      });

      const data = (await response.json()) as RoleResponse;

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.name).toBe(newRoleData.name);
      expect(data.displayName).toBe(newRoleData.displayName);
    });

    it("should reject duplicate role name", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: testRole.name,
          displayName: "Duplicate Role",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("should reject request from non-admin", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${regularToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "test-role",
          displayName: "Test Role",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("GET /admin/roles/:id", () => {
    it("should get role by ID", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${testRole.id}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

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

  describe("PATCH /admin/roles/:id", () => {
    it("refuses a roles.write caller without admin changing core's admin role's requires2fa", async () => {
      const adminRole = await prisma.role.findFirstOrThrow({
        where: { name: "admin", serviceId: CORE_SERVICE_ID },
      });
      const writer = await getTestPrincipalToken({
        permissions: ["roles.write"],
      });
      try {
        const response = await fetch(
          `${BASE_URL}/v1/admin/roles/${adminRole.id}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${writer}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ requires2fa: !adminRole.requires2fa }),
          }
        );
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(
          (await prisma.role.findUniqueOrThrow({ where: { id: adminRole.id } }))
            .requires2fa
        ).toBe(adminRole.requires2fa);
      } finally {
        await prisma.role.update({
          where: { id: adminRole.id },
          data: { requires2fa: adminRole.requires2fa },
        });
      }
    });

    it("lets a caller holding everything a role grants change its requires2fa", async () => {
      const role = await createTestRole();
      const response = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requires2fa: true }),
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
    });

    it("should update role", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${testRole.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Updated Role Name" }),
        }
      );

      const data = (await response.json()) as RoleResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.displayName).toBe("Updated Role Name");
    });

    it("should update role description", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${testRole.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ description: "Updated description" }),
        }
      );

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

  describe("PUT /admin/roles/:id/permissions", () => {
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

  describe("GET /admin/roles/:id/users", () => {
    it("should return 200 with users list for valid role", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${testRole.id}/users`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const data = (await response.json()) as RoleUsersResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.roleId).toBe(testRole.id);
      expect(data.users).toBeDefined();
      expect(Array.isArray(data.users)).toBe(true);
    });

    it("should return 404 for non-existent role", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${NON_EXISTENT_UUID}/users`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should reject request without admin token", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${testRole.id}/users`,
        {
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("DELETE /admin/roles/:id/users/:userId", () => {
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

    it("should return 403 for request without admin token", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${testRole.id}/users/${regularUser.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      // Server returns 403 for non-admin tokens (authenticated but not authorized)
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("DELETE /admin/roles/:id", () => {
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

    it("should return 403 when deleting a system role", async () => {
      const systemRole = await createTestRole({ isSystem: true });

      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${systemRole.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(
        await prisma.role.findUnique({ where: { id: systemRole.id } })
      ).not.toBeNull();
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

    it("should return 403 for request without admin token", async () => {
      const roleToDelete = await createTestRole();

      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${roleToDelete.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("PUT /admin/roles/:id/permissions - validation", () => {
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
    });

    it("should return 400 for mixed valid and invalid permission IDs", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${testRole.id}/permissions`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ permissionIds: [testPermission.id, 999999] }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
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

  describe("permission checks come before the archive state", () => {
    it("answers 403, not 409, to a roles.read caller on an archived role", async () => {
      const role = await createTestRole();
      await prisma.role.update({
        where: { id: role.id },
        data: { isActive: false, archivedAt: new Date() },
      });
      const readOnly = await getTestPrincipalToken({
        permissions: ["roles.read"],
      });

      const response = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${readOnly}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Nope" }),
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const asAdmin = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Nope" }),
      });
      expect(asAdmin.status).toBe(HTTP_STATUS.CONFLICT);
    });
  });

  // ===========================================================================
  // Archive / Restore
  // ===========================================================================

  describe("POST /admin/roles/:id/archive and /restore", () => {
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

    it("should return 403 when archiving a system role", async () => {
      const systemRole = await createTestRole({ isSystem: true });

      const response = await archiveRole(systemRole.id);
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const row = await prisma.role.findUnique({
        where: { id: systemRole.id },
      });
      expect(row?.archivedAt).toBeNull();
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

      const patchResponse = await fetch(
        `${BASE_URL}/v1/admin/roles/${role.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Should Not Apply" }),
        }
      );
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

    it("should return 403 for archive without permission", async () => {
      const role = await createTestRole();
      await deactivateRole(role.id);

      const response = await archiveRole(role.id, regularToken);
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should return 403 (not 409) for unauthorized callers on live and archived roles alike", async () => {
      const liveRole = await createTestRole();
      const archivedRole = await createTestRole();
      await deactivateRole(archivedRole.id);
      await archiveRole(archivedRole.id);

      // Same status for both ids — an unauthorized caller must not be able
      // to distinguish archived rows (409) from live ones (403).
      for (const id of [liveRole.id, archivedRole.id]) {
        const response = await fetch(`${BASE_URL}/v1/admin/roles/${id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${regularToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Should Not Apply" }),
        });
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      }
    });
  });

  // ===========================================================================
  // Permission resolution safety
  // ===========================================================================

  describe("permission resolution across the role archive lifecycle", () => {
    it("should stop granting when the role is archived and stay excluded after restore until reactivated", async () => {
      const resolutionClient = await createTestClient({
        clientType: "confidential",
      });
      // check-permission answers a client of no organization only if it is a
      // service's.
      await makeServiceOf(resolutionClient.id);
      const user = await createTestUser();
      const role = await createTestRole();
      const permission = await createTestPermission();
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id },
      });

      expect(
        await checkUserPermission(resolutionClient, user.id, permission.name)
      ).toBe(true);

      // Deactivate: resolution excludes inactive roles
      const deactivate = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isActive: false }),
      });
      expect(deactivate.status).toBe(HTTP_STATUS.OK);
      expect(
        await checkUserPermission(resolutionClient, user.id, permission.name)
      ).toBe(false);

      // Archive: still excluded
      const archive = await fetch(
        `${BASE_URL}/v1/admin/roles/${role.id}/archive`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(archive.status).toBe(HTTP_STATUS.NO_CONTENT);
      expect(
        await checkUserPermission(resolutionClient, user.id, permission.name)
      ).toBe(false);

      // Restore: comes back deactivated, so STILL excluded
      const restore = await fetch(
        `${BASE_URL}/v1/admin/roles/${role.id}/restore`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(restore.status).toBe(HTTP_STATUS.OK);
      expect(
        await checkUserPermission(resolutionClient, user.id, permission.name)
      ).toBe(false);

      // Explicit reactivation brings the grant back
      const reactivate = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isActive: true }),
      });
      expect(reactivate.status).toBe(HTTP_STATUS.OK);
      expect(
        await checkUserPermission(resolutionClient, user.id, permission.name)
      ).toBe(true);
    });

    it("should stop granting permanently after role hard delete", async () => {
      const resolutionClient = await createTestClient({
        clientType: "confidential",
      });
      // check-permission answers a client of no organization only if it is a
      // service's.
      await makeServiceOf(resolutionClient.id);
      const user = await createTestUser();
      const role = await createTestRole();
      const permission = await createTestPermission();
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id },
      });

      expect(
        await checkUserPermission(resolutionClient, user.id, permission.name)
      ).toBe(true);

      const deleteResponse = await fetch(
        `${BASE_URL}/v1/admin/roles/${role.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(deleteResponse.status).toBe(HTTP_STATUS.NO_CONTENT);

      expect(
        await checkUserPermission(resolutionClient, user.id, permission.name)
      ).toBe(false);
    });
  });

  describe("auth.role.created", () => {
    let endpointId: string;

    beforeAll(async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.role.created"] }
      );
      endpointId = endpoint.id;
    });

    // emitTx → core.outbox → reaper → fan-out creates the delivery.
    const findCreatedEvent = async (roleId: string) => {
      const where = {
        webhookEndpointId: endpointId,
        eventType: "auth.role.created",
        payload: { path: ["entityId"], equals: roleId },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
      const delivery = await prisma.webhookDelivery.findFirstOrThrow({
        where,
      });
      return delivery.payload as {
        organizationId: string;
        entityType: string;
        data: Record<string, unknown>;
      };
    };

    it("is emitted when a role is created", async () => {
      const uniqueId = generateUniqueId();
      const response = await fetch(`${BASE_URL}/v1/admin/roles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `created-event-${uniqueId}`,
          displayName: `Created Event ${uniqueId}`,
        }),
      });
      expect(response.status).toBe(HTTP_STATUS.CREATED);
      const role = (await response.json()) as RoleResponse;

      const payload = await findCreatedEvent(role.id!);
      expect(payload).toMatchObject({
        organizationId: DEFAULT_ORGANIZATION_ID,
        entityType: "Role",
        data: { id: role.id, name: role.name },
      });
      expect(payload.data.duplicatedFrom).toBeUndefined();
    });

    it("is emitted when a role is duplicated, naming the source", async () => {
      const uniqueId = generateUniqueId();
      const response = await fetch(
        `${BASE_URL}/v1/admin/roles/${testRole.id}/duplicate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: `duplicated-event-${uniqueId}` }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.CREATED);
      const role = (await response.json()) as RoleResponse;

      const payload = await findCreatedEvent(role.id!);
      expect(payload).toMatchObject({
        organizationId: DEFAULT_ORGANIZATION_ID,
        entityType: "Role",
        data: { id: role.id, name: role.name, duplicatedFrom: testRole.id },
      });
    });
  });
  describe("DELETE /admin/roles/:id/users/:userId?organizationId", () => {
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

      const listed = await fetch(
        `${BASE_URL}/v1/admin/roles/${role.id}/users`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
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

  describe("a human's access after the role changes", () => {
    const REDIRECT_URI = "http://localhost:3000/role-change-callback";

    const login = async () => {
      const client = await createTestClient({ redirectUris: [REDIRECT_URI] });
      const user = await createTestUser();
      const role = await createTestRole();
      const rolesRead = await prisma.permission.findFirstOrThrow({
        where: { name: "roles.read", retiredAt: null },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: rolesRead.id },
      });
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id },
      });

      const { code, verifier } = await browserLogin({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        scope: "openid offline_access core:admin",
        email: user.email,
        password: user.plainPassword,
      });
      const token = async (params: Record<string, string>) => {
        const res = await fetch(`${BASE_URL}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: client.clientId, ...params }),
        });
        expect(res.status).toBe(200);
        return (await res.json()) as {
          access_token: string;
          refresh_token: string;
        };
      };
      const tokens = await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      const refresh = () =>
        token({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        });
      return { role, tokens, refresh };
    };

    const listRoles = async (accessToken: string) =>
      (
        await fetch(`${BASE_URL}/v1/admin/roles`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      ).status;

    it("loses a permission the role drops on the token it already holds, and on refresh", async () => {
      const { role, tokens, refresh } = await login();
      expect(await listRoles(tokens.access_token)).toBe(HTTP_STATUS.OK);

      const cleared = await fetch(
        `${BASE_URL}/v1/admin/roles/${role.id}/permissions`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ permissionIds: [] }),
        }
      );
      expect(cleared.status).toBe(HTTP_STATUS.OK);

      expect(await listRoles(tokens.access_token)).toBe(HTTP_STATUS.FORBIDDEN);
      const refreshed = await refresh();
      expect(decodeJwt(refreshed.access_token)).not.toHaveProperty(
        "permissions"
      );
      expect(await listRoles(refreshed.access_token)).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("loses the role's permissions when the role is deleted", async () => {
      const { role, tokens, refresh } = await login();
      expect(await listRoles(tokens.access_token)).toBe(HTTP_STATUS.OK);

      const deleted = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(deleted.status).toBe(HTTP_STATUS.NO_CONTENT);

      expect(await listRoles(tokens.access_token)).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await listRoles((await refresh()).access_token)).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });
  });
});
