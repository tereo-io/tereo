// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../../../../support/principals.js";
import { getAccessTokenForUser } from "../../../../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../../../../support/auth/clients.js";
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestOrganization,
  addTestOrgMember,
  type OrganizationResponse,
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

let adminToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("PUT /v1/admin/organizations/:id/members/:userId/roles", () => {
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

      expect((await putFor(orgAdminToken)).status).toBe(HTTP_STATUS.FORBIDDEN);
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
