// @module-tag int
// @module-tag auth
import { ensurePermission, TEST_SERVICE } from "../../support/testService.js";
import { createTestRole, createTestUser } from "../../support/auth/users.js";
import { ensureTestOrganization } from "../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CORE_SERVICE_ID } from "../../../definitions/index.js";
import { createTestGuest } from "../../support/auth/guests.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";

const run = randomUUID().slice(0, 8);
const PERMISSION = `${TEST_SERVICE.namespace}.group-merge.read`;

let actorId: string;
const groupIds: string[] = [];

const newOrg = () => ensureTestOrganization(`group-merge-${randomUUID()}`);

/** A role granting PERMISSION, which is org-assignable. */
const grantingRole = async (data: { requires2fa?: boolean } = {}) => {
  const permission = await ensurePermission(PERMISSION);
  const role = await createTestRole();
  await prisma.rolePermission.create({
    data: { roleId: role.id, permissionId: permission.id },
  });
  if (data.requires2fa) {
    await prisma.role.update({
      where: { id: role.id },
      data: { requires2fa: true },
    });
  }
  return role;
};

/** A group holding `roleIds`, with `userIds` as members. */
const groupWith = async (
  organizationId: string | null,
  userIds: string[],
  roleIds: string[]
) => {
  const group = await prisma.group.create({
    data: {
      organizationId,
      slug: `merge-${randomUUID().slice(0, 8)}-${run}`,
      name: "Merge test group",
      definitionSource: "local",
      createdBy: actorId,
    },
  });
  groupIds.push(group.id);
  if (userIds.length > 0) {
    await prisma.groupMember.createMany({
      data: userIds.map((userId) => ({
        groupId: group.id,
        userId,
        addedBy: actorId,
      })),
    });
  }
  if (roleIds.length > 0) {
    await prisma.groupRole.createMany({
      data: roleIds.map((roleId) => ({
        groupId: group.id,
        roleId,
        addedBy: actorId,
      })),
    });
  }
  return group;
};

const joinOrg = (organizationId: string, userId: string) =>
  prisma.organizationMember.create({ data: { organizationId, userId } });

beforeAll(async () => {
  actorId = (await createTestUser()).id;
  await ensurePermission(PERMISSION);
  await prisma.permission.update({
    where: { name: PERMISSION },
    data: { orgAssignable: true },
  });
});

// Groups are never deleted by core; tests remove theirs so that no admin
// they granted outlives the file.
afterAll(async () => {
  await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
  await prisma.groupRole.deleteMany({ where: { groupId: { in: groupIds } } });
  await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
});

describe("db.roles group-derived roles", () => {
  it("a member gains the group's role permissions in getUserPermissions", async () => {
    const user = await createTestUser();
    const role = await grantingRole();
    await groupWith(null, [user.id], [role.id]);

    expect(await db.roles.getUserPermissions(user.id)).toContain(PERMISSION);
    expect(await db.roles.getUserPermissionsAnywhere(user.id)).toContain(
      PERMISSION
    );
  });

  it("an org group's roles count only in that org", async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const user = await createTestUser();
    await joinOrg(orgA, user.id);
    await joinOrg(orgB, user.id);
    const role = await grantingRole();
    await groupWith(orgA, [user.id], [role.id]);

    expect(await db.roles.getUserPermissions(user.id, orgA)).toContain(
      PERMISSION
    );
    expect(await db.roles.getUserPermissions(user.id, orgB)).not.toContain(
      PERMISSION
    );
    expect(await db.roles.getUserPermissions(user.id)).not.toContain(
      PERMISSION
    );
  });

  it("an org group's role grants only its org-assignable permissions", async () => {
    const orgA = await newOrg();
    const user = await createTestUser();
    await joinOrg(orgA, user.id);
    const role = await grantingRole();
    const globalOnly = await ensurePermission(
      `${TEST_SERVICE.namespace}.group-merge.global`
    );
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: globalOnly.id },
    });
    await groupWith(orgA, [user.id], [role.id]);

    const permissions = await db.roles.getUserPermissions(user.id, orgA);
    expect(permissions).toContain(PERMISSION);
    expect(permissions).not.toContain(globalOnly.name);
  });

  it("an archived group grants nothing", async () => {
    const user = await createTestUser();
    const role = await grantingRole();
    const group = await groupWith(null, [user.id], [role.id]);
    await db.groups.setArchived(group.id, new Date());

    expect(await db.roles.getUserPermissions(user.id)).not.toContain(
      PERMISSION
    );
    expect(await db.roles.getLiveUserRoles(user.id, null)).toEqual([]);
  });

  it("an archived role held via a group grants nothing, and counts again when restored", async () => {
    const user = await createTestUser();
    const role = await grantingRole();
    await groupWith(null, [user.id], [role.id]);
    await prisma.role.update({
      where: { id: role.id },
      data: { isActive: false, archivedAt: new Date() },
    });

    expect(await db.roles.getUserPermissions(user.id)).not.toContain(
      PERMISSION
    );

    await prisma.role.update({
      where: { id: role.id },
      data: { isActive: true, archivedAt: null },
    });
    expect(await db.roles.getUserPermissions(user.id)).toContain(PERMISSION);
  });

  it("a deactivated role held via a group counts only with includeInactiveRoles", async () => {
    const user = await createTestUser();
    const role = await grantingRole();
    await groupWith(null, [user.id], [role.id]);
    await prisma.role.update({
      where: { id: role.id },
      data: { isActive: false },
    });

    expect(await db.roles.getUserPermissionsAnywhere(user.id)).not.toContain(
      PERMISSION
    );
    expect(
      await db.roles.getUserPermissionsAnywhere(user.id, undefined, {
        includeInactiveRoles: true,
      })
    ).toContain(PERMISSION);
  });

  it("a retired role held via a group grants nothing", async () => {
    const user = await createTestUser();
    const role = await grantingRole();
    await groupWith(null, [user.id], [role.id]);
    await prisma.role.update({
      where: { id: role.id },
      data: { retiredAt: new Date() },
    });

    expect(await db.roles.getUserPermissions(user.id)).not.toContain(
      PERMISSION
    );
  });

  it("an org group grants nothing once the user is no longer an org member", async () => {
    const orgA = await newOrg();
    const user = await createTestUser();
    await joinOrg(orgA, user.id);
    const role = await grantingRole();
    await groupWith(orgA, [user.id], [role.id]);
    expect(await db.roles.getUserPermissions(user.id, orgA)).toContain(
      PERMISSION
    );

    await prisma.organizationMember.deleteMany({
      where: { organizationId: orgA, userId: user.id },
    });

    expect(await db.roles.getUserPermissions(user.id, orgA)).not.toContain(
      PERMISSION
    );
    expect(await db.roles.getUserPermissionsAnywhere(user.id)).not.toContain(
      PERMISSION
    );
    expect(await db.roles.getLiveUserRoles(user.id, "memberships")).toEqual([]);
  });

  it("an org group grants nothing in a deactivated org", async () => {
    const orgA = await newOrg();
    const user = await createTestUser();
    await joinOrg(orgA, user.id);
    const role = await grantingRole();
    await groupWith(orgA, [user.id], [role.id]);
    await prisma.organization.update({
      where: { id: orgA },
      data: { isActive: false },
    });

    expect(await db.roles.getUserPermissions(user.id, orgA)).not.toContain(
      PERMISSION
    );
    expect(await db.roles.getLiveUserRoles(user.id, "memberships")).toEqual([]);
  });

  it("a role held directly and via a group appears once in getLiveUserRoles", async () => {
    const user = await createTestUser();
    const role = await grantingRole();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    const group = await groupWith(null, [user.id], [role.id]);

    const both = await db.roles.getLiveUserRoles(user.id, null);
    expect(both.map((a) => [a.roleId, a.via])).toEqual([
      [role.id, { kind: "direct" }],
    ]);

    await db.roles.removeUserRole(user.id, role.id);

    const viaGroup = await db.roles.getLiveUserRoles(user.id, null);
    expect(viaGroup.map((a) => [a.roleId, a.via])).toEqual([
      [role.id, { kind: "group", groupId: group.id }],
    ]);
    expect(await db.roles.getUserPermissions(user.id)).toContain(PERMISSION);
  });

  it("a guest's group rows obey the guest floor", async () => {
    const orgA = await newOrg();
    const { user } = await createTestGuest({ organizationId: orgA });
    const role = await grantingRole();
    const globalGroupRole = await grantingRole();
    await groupWith(orgA, [user.id], [role.id]);
    await groupWith(null, [user.id], [globalGroupRole.id]);

    // Neither is guest-assignable; the global one is global besides.
    expect(await db.roles.getUserPermissionsAnywhere(user.id)).toEqual([]);

    await prisma.role.update({
      where: { id: role.id },
      data: { guestAssignable: true },
    });
    await prisma.role.update({
      where: { id: globalGroupRole.id },
      data: { guestAssignable: true },
    });
    expect(await db.roles.getUserPermissions(user.id, orgA)).toEqual([
      PERMISSION,
    ]);
    expect(
      (await db.roles.getLiveUserRoles(user.id, orgA)).map((a) => a.roleId)
    ).toEqual([role.id]);
  });

  it("getAdminAssignments includes admin held through a global group with groupId set", async () => {
    const user = await createTestUser();
    const admin = await prisma.role.findFirstOrThrow({
      where: { name: "admin", serviceId: CORE_SERVICE_ID },
    });
    const orgA = await newOrg();
    await joinOrg(orgA, user.id);
    const orgGroup = await groupWith(orgA, [user.id], [admin.id]);
    const group = await groupWith(null, [user.id], [admin.id]);

    const mine = (await db.roles.getAdminAssignments()).filter(
      (a) => a.userId === user.id
    );
    expect(mine).toEqual([
      { userId: user.id, roleId: admin.id, groupId: group.id },
    ]);
    expect(mine.some((a) => a.groupId === orgGroup.id)).toBe(false);

    await db.groups.setArchived(group.id, new Date());
    expect(
      (await db.roles.getAdminAssignments()).some((a) => a.userId === user.id)
    ).toBe(false);
  });

  it("getUserIdsByRoleId includes group members", async () => {
    const direct = await createTestUser();
    const member = await createTestUser();
    const role = await grantingRole();
    await prisma.userRole.create({
      data: { userId: direct.id, roleId: role.id },
    });
    await groupWith(null, [member.id, direct.id], [role.id]);

    const ids = (await db.roles.getUserIdsByRoleId(role.id)).map(
      (h) => h.userId
    );
    expect(ids.sort()).toEqual([direct.id, member.id].sort());
  });

  it("getUsersByRoleId lists group holders with via", async () => {
    const member = await createTestUser();
    const role = await grantingRole();
    const group = await groupWith(null, [member.id], [role.id]);

    expect(await db.roles.getUsersByRoleId(role.id)).toEqual([
      expect.objectContaining({
        id: member.id,
        organizationId: null,
        expiresAt: null,
        via: { kind: "group", groupId: group.id },
      }),
    ]);
  });

  it("holdsRoleWhere matches a member of a group holding the role", async () => {
    const member = await createTestUser();
    const outsider = await createTestUser();
    const role = await grantingRole();
    const group = await groupWith(null, [member.id], [role.id]);

    const holders = await prisma.user.findMany({
      where: {
        id: { in: [member.id, outsider.id] },
        ...db.roles.holdsRoleWhere({ id: role.id }),
      },
      select: { id: true },
    });
    expect(holders.map((u) => u.id)).toEqual([member.id]);

    await db.groups.setArchived(group.id, new Date());
    expect(
      await prisma.user.count({
        where: { id: member.id, ...db.roles.holdsRoleWhere({ id: role.id }) },
      })
    ).toBe(0);
  });

  it("userRolesRequire2fa is true for a requires2fa role held via a group", async () => {
    const user = await createTestUser();
    const role = await grantingRole({ requires2fa: true });
    expect(await db.totp.userRolesRequire2fa(user.id)).toBe(false);

    await groupWith(null, [user.id], [role.id]);

    expect(await db.totp.userRolesRequire2fa(user.id)).toBe(true);
  });

  it("countInertOrgAssignments counts an org group holding a role with a global-only permission", async () => {
    const orgA = await newOrg();
    const role = await createTestRole();
    const globalOnly = await ensurePermission(
      `${TEST_SERVICE.namespace}.group-merge.inert`
    );
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: globalOnly.id },
    });
    const before = await db.roles.countInertOrgAssignments();

    await groupWith(orgA, [], [role.id]);

    expect(await db.roles.countInertOrgAssignments()).toBe(before + 1);
  });

  it("getOrgIdsHoldingRole includes organizations whose groups hold the role", async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const user = await createTestUser();
    const role = await createTestRole();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId: orgB },
    });
    await groupWith(orgA, [], [role.id]);
    const archived = await groupWith(await newOrg(), [], [role.id]);
    await db.groups.setArchived(archived.id, new Date());

    expect(
      await prisma.$transaction((tx) =>
        db.roles.getOrgIdsHoldingRole(role.id, 10, tx)
      )
    ).toEqual([orgA, orgB].sort());
  });
});
