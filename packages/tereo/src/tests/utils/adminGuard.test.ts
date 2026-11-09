// @module-tag int
// @module-tag auth
// @module-tag race

import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../support/principals.js";
import { removeMembers } from "../../utils/groups.js";
import { generateUniqueId } from "../support/auth/crypto.js";
import { createTestUser } from "../support/auth/users.js";
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { assertAdminRemains } from "../../utils/adminGuard.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";

/**
 * The last-admin guard. Other suites leave admins behind, so this file sets
 * their global `admin` assignments (expired) and admin groups (archived)
 * aside for its duration and restores them afterwards; the users made here
 * are then the only admins.
 */
describe("assertAdminRemains", () => {
  const setAside = new Map<string, Date | null>();
  const archivedGroupIds: string[] = [];
  let callerToken: string;
  let adminPermissionId: string;

  const adminAssignments = () =>
    prisma.userRole.findMany({
      where: {
        organizationId: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        user: { isActive: true, userType: "human" },
        role: {
          isActive: true,
          archivedAt: null,
          retiredAt: null,
          rolePermissions: {
            some: { permission: { name: "admin", retiredAt: null } },
          },
        },
      },
    });

  const grantsAdmin = {
    isActive: true,
    archivedAt: null,
    retiredAt: null,
    rolePermissions: {
      some: { permission: { name: "admin", retiredAt: null } },
    },
  };

  const adminRole = async () =>
    prisma.role.create({
      data: {
        name: `guard-admin-${generateUniqueId()}`,
        displayName: "Guard test admin",
        rolePermissions: { create: [{ permissionId: adminPermissionId }] },
      },
    });

  const makeAdmin = async () => {
    const user = await createTestUser();
    const role = await adminRole();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    return { user, role };
  };

  beforeAll(async () => {
    // removeMembers emits events, which name the default organization.
    await ensureDefaultOrganization();
    adminPermissionId = (
      await prisma.permission.findUniqueOrThrow({ where: { name: "admin" } })
    ).id;
    // Holds admin, since stripping an admin's roles needs every permission
    // they hold, but as a service account: it is not an administrator the
    // guard counts.
    const callerId = randomUUID();
    callerToken = await getTestPrincipalToken({
      userId: callerId,
      permissions: ["admin"],
    });
    await prisma.user.update({
      where: { id: callerId },
      data: { userType: "service_account" },
    });
    for (const a of await adminAssignments()) {
      setAside.set(a.id, a.expiresAt);
      await prisma.userRole.update({
        where: { id: a.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
    }
    const adminGroups = await prisma.group.findMany({
      where: {
        organizationId: null,
        archivedAt: null,
        roles: { some: { role: grantsAdmin } },
      },
      select: { id: true },
    });
    archivedGroupIds.push(...adminGroups.map((g) => g.id));
    await prisma.group.updateMany({
      where: { id: { in: archivedGroupIds } },
      data: { archivedAt: new Date() },
    });
  });

  afterAll(async () => {
    for (const [id, expiresAt] of setAside) {
      await prisma.userRole.updateMany({ where: { id }, data: { expiresAt } });
    }
    await prisma.group.updateMany({
      where: { id: { in: archivedGroupIds } },
      data: { archivedAt: null },
    });
  });

  /** A global group holding a fresh admin role, with `size` new members. */
  const adminGroup = async (size: number) => {
    const role = await adminRole();
    const members = [];
    for (let i = 0; i < size; i++) members.push(await createTestUser());
    const group = await prisma.group.create({
      data: {
        slug: `guard-${generateUniqueId()}`,
        name: "Guard test group",
        definitionSource: "local",
        createdBy: members[0].id,
      },
    });
    await prisma.groupMember.createMany({
      data: members.map((m) => ({
        groupId: group.id,
        userId: m.id,
        addedBy: m.id,
      })),
    });
    await prisma.groupRole.create({
      data: { groupId: group.id, roleId: role.id, addedBy: members[0].id },
    });
    return { group, role, memberIds: members.map((m) => m.id) };
  };

  const dropGroup = async (groupId: string) => {
    await prisma.groupMember.deleteMany({ where: { groupId } });
    await prisma.groupRole.deleteMany({ where: { groupId } });
    await prisma.group.delete({ where: { id: groupId } });
  };

  const removeMember = (groupId: string, userId: string) =>
    fetch(`${BASE_URL}/v1/admin/groups/${groupId}/members/${userId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${callerToken}` },
    });

  it("removing admin-group members passes while another member remains, and refuses the last", async () => {
    const { group, memberIds } = await adminGroup(4);
    const [a, b, c, d] = memberIds;
    try {
      // Several at once, leaving two.
      await prisma.$transaction((tx) =>
        removeMembers({ mode: "provisioning" }, group.id, [a, b], tx)
      );
      expect((await removeMember(group.id, c)).status).toBe(
        HTTP_STATUS.NO_CONTENT
      );
      const last = await removeMember(group.id, d);
      expect(last.status).toBe(HTTP_STATUS.CONFLICT);
      expect(
        await prisma.groupMember.count({ where: { groupId: group.id } })
      ).toBe(1);
    } finally {
      await dropGroup(group.id);
    }
  });

  it("removing every admin-group member in one call is refused", async () => {
    const { group, memberIds } = await adminGroup(3);
    try {
      await expect(
        prisma.$transaction((tx) =>
          removeMembers({ mode: "provisioning" }, group.id, memberIds, tx)
        )
      ).rejects.toThrow(/no active administrator/);
      expect(
        await prisma.groupMember.count({ where: { groupId: group.id } })
      ).toBe(3);
    } finally {
      await dropGroup(group.id);
    }
  });

  it("weighs each kind of removal against the remaining admins", async () => {
    const { group, role, memberIds } = await adminGroup(2);
    const [a, b] = memberIds;
    const direct = await makeAdmin();
    const guard = (removal: Parameters<typeof assertAdminRemains>[0]) =>
      prisma.$transaction((tx) => assertAdminRemains(removal, tx));
    try {
      // The direct admin remains whatever the group loses.
      await guard({ kind: "group", groupId: group.id });
      await guard({
        kind: "groupRoles",
        groupId: group.id,
        roleIds: [role.id],
      });
      await guard({ kind: "groupMembers", groupId: group.id, userIds: [a, b] });
      await guard({ kind: "role", roleId: role.id });
      // The group's members remain whatever the direct admin loses.
      await guard({ kind: "user", userId: direct.user.id });
      await guard({
        kind: "direct",
        userId: direct.user.id,
        roleIds: [direct.role.id],
      });
      await guard({
        kind: "directExcept",
        userId: direct.user.id,
        keepRoleIds: [],
      });
      // A group member's direct assignments do not cover its group role.
      await guard({ kind: "directExcept", userId: a, keepRoleIds: [] });

      await prisma.userRole.deleteMany({ where: { userId: direct.user.id } });
      expect(await db.roles.adminExists()).toBe(true);
      await expect(guard({ kind: "group", groupId: group.id })).rejects.toThrow(
        /no active administrator/
      );
      await expect(
        guard({ kind: "groupRoles", groupId: group.id, roleIds: [role.id] })
      ).rejects.toThrow(/no active administrator/);
      await expect(guard({ kind: "role", roleId: role.id })).rejects.toThrow(
        /no active administrator/
      );
      await guard({ kind: "groupMembers", groupId: group.id, userIds: [a] });
      await guard({ kind: "user", userId: b });
      await guard(null);

      // An org group grants no admin outside its organization, nor does an
      // archived group.
      await prisma.group.update({
        where: { id: group.id },
        data: {
          organizationId: await ensureTestOrganization(
            `guard-${generateUniqueId()}`
          ),
        },
      });
      expect(await db.roles.adminExists()).toBe(false);
      await prisma.group.update({
        where: { id: group.id },
        data: { organizationId: null, archivedAt: new Date() },
      });
      expect(await db.roles.adminExists()).toBe(false);
      // With no admin at all there is nothing to protect.
      await guard({ kind: "user", userId: a });
    } finally {
      await dropGroup(group.id);
      await prisma.userRole.deleteMany({ where: { userId: direct.user.id } });
    }
  });

  const removeAllRoles = (userId: string) =>
    fetch(`${BASE_URL}/v1/admin/users/${userId}/roles`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${callerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roleIds: [] }),
    });

  it("two concurrent removals of the last two admins: one is refused", async () => {
    const x = await makeAdmin();
    const y = await makeAdmin();

    const responses = await Promise.all([
      removeAllRoles(x.user.id),
      removeAllRoles(y.user.id),
    ]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([HTTP_STATUS.OK, HTTP_STATUS.CONFLICT]);
    expect((await adminAssignments()).length).toBe(1);

    // Leave the remaining one for the next test to find on its own.
    await prisma.userRole.deleteMany({
      where: { userId: { in: [x.user.id, y.user.id] } },
    });
  });

  it("keeping only an expired admin assignment counts as removing admin", async () => {
    const { user } = await makeAdmin();
    const expired = await adminRole();
    await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: expired.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${callerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roleIds: [expired.id] }),
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect((await adminAssignments()).length).toBe(1);

    await prisma.userRole.deleteMany({ where: { userId: user.id } });
  });

  it("removing the last admin's direct assignment passes while a global group grants the same role", async () => {
    const { user, role } = await makeAdmin();
    const group = await prisma.group.create({
      data: {
        slug: `guard-${generateUniqueId()}`,
        name: "Guard test group",
        definitionSource: "local",
        createdBy: user.id,
      },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: user.id, addedBy: user.id },
    });
    await prisma.groupRole.create({
      data: { groupId: group.id, roleId: role.id, addedBy: user.id },
    });

    try {
      expect((await removeAllRoles(user.id)).status).toBe(HTTP_STATUS.OK);

      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id },
      });
      const res = await fetch(
        `${BASE_URL}/v1/admin/roles/${role.id}/users/${user.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${callerToken}` },
        }
      );
      expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    } finally {
      // A group's admin is not set aside like the others; none may outlive
      // the test.
      await prisma.groupMember.deleteMany({ where: { groupId: group.id } });
      await prisma.groupRole.deleteMany({ where: { groupId: group.id } });
      await prisma.group.delete({ where: { id: group.id } });
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
    }
  });

  it("deleting the last admin role is refused before any token is revoked", async () => {
    const { role } = await makeAdmin();

    // A service account holds the role too; its tokens would be revoked
    // with the delete.
    const owner = await createTestUser();
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: `guard-${generateUniqueId()}`,
        name: "Guard test client",
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        ownerId: owner.id,
      },
    });
    const account = await prisma.user.create({
      data: {
        email: `guard-${generateUniqueId()}@services.example.com`,
        passwordHash: "!",
        userType: "service_account",
        oauthClientId: client.id,
      },
    });
    await prisma.userRole.create({
      data: { userId: account.id, roleId: role.id },
    });
    const jti = randomUUID();
    await prisma.accessToken.create({
      data: {
        jti,
        clientId: client.id,
        userId: account.id,
        scopes: [],
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const response = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${callerToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);

    const token = await prisma.accessToken.findUniqueOrThrow({
      where: { jti },
    });
    expect(token.revokedAt).toBeNull();
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBe(
      null
    );

    await prisma.userRole.deleteMany({ where: { roleId: role.id } });
  });
});
