// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../../support/auth/login.js";
import { LOGIN_CLIENT } from "../../../../../../../definitions/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../../support/auth/constants.js";
import {
  createAdminUser,
  createTestRole,
  createTestUser,
} from "../../../../../../support/auth/users.js";

interface RoleUsersResponse {
  roleId: string;
  users: Array<Record<string, unknown> & { id: string }>;
  groups: Array<Record<string, unknown> & { id: string }>;
}

const groupIds: string[] = [];

afterAll(async () => {
  await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
  await prisma.groupRole.deleteMany({ where: { groupId: { in: groupIds } } });
  await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
});

let testRole: Awaited<ReturnType<typeof createTestRole>>;
let adminToken: string;

beforeAll(async () => {
  const adminUser = await createAdminUser();
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

describe("GET /v1/admin/roles/:id/users", () => {
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
    expect(Array.isArray(data.users)).toBe(true);
    expect(Array.isArray(data.groups)).toBe(true);
  });

  it("lists direct holders as users and group holders as groups", async () => {
    const role = await createTestRole();
    const direct = await createTestUser();
    const member = await createTestUser();
    await prisma.userRole.create({
      data: { userId: direct.id, roleId: role.id },
    });
    const group = await prisma.group.create({
      data: {
        organizationId: null,
        slug: `role-users-${randomUUID().slice(0, 8)}`,
        name: "Role users group",
        definitionSource: "local",
        createdBy: direct.id,
      },
    });
    groupIds.push(group.id);
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: member.id, addedBy: direct.id },
    });
    await prisma.groupRole.create({
      data: { groupId: group.id, roleId: role.id, addedBy: direct.id },
    });

    const response = await fetch(
      `${BASE_URL}/v1/admin/roles/${role.id}/users`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    const data = (await response.json()) as RoleUsersResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.users).toEqual([
      {
        id: direct.id,
        email: direct.email,
        name: direct.name,
        isActive: true,
        organizationId: null,
        organization: null,
        expiresAt: null,
        via: { kind: "direct" },
      },
    ]);
    expect(data.groups).toEqual([
      {
        id: group.id,
        slug: group.slug,
        name: group.name,
        organizationId: null,
        organization: null,
        memberCount: 1,
      },
    ]);
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
});
