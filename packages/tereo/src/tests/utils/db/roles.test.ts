// @module-tag int
// @module-tag auth
import { ensurePermission, TEST_SERVICE } from "../../support/testService.js";
import { createTestRole, createTestUser } from "../../support/auth/users.js";
import { ensureTestOrganization } from "../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

  it("a group's row stands in getLiveUserRoles over an expiring direct one", async () => {
    const user = await createTestUser();
    const role = await grantingRole();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, expiresAt },
    });
    const group = await groupWith(null, [user.id], [role.id]);

    const live = await db.roles.getLiveUserRoles(user.id, null);
    expect(live.map((a) => [a.roleId, a.via, a.expiresAt])).toEqual([
      [role.id, { kind: "group", groupId: group.id }, null],
    ]);
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

  it("getUsersByRoleId lists direct holders, and the live groups holding the role", async () => {
    const direct = await createTestUser();
    const member = await createTestUser();
    const orgA = await newOrg();
    const role = await grantingRole();
    await prisma.userRole.create({
      data: { userId: direct.id, roleId: role.id },
    });
    const group = await groupWith(null, [member.id, direct.id], [role.id]);
    const orgGroup = await groupWith(orgA, [], [role.id]);
    const archived = await groupWith(null, [member.id], [role.id]);
    await db.groups.setArchived(archived.id, new Date());
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgA },
      select: { id: true, name: true, slug: true },
    });

    const { users, groups } = await db.roles.getUsersByRoleId(role.id);
    expect(users).toEqual([
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
    expect(groups.sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual(
      [
        {
          id: group.id,
          slug: group.slug,
          name: group.name,
          organizationId: null,
          organization: null,
          memberCount: 2,
        },
        {
          id: orgGroup.id,
          slug: orgGroup.slug,
          name: orgGroup.name,
          organizationId: orgA,
          organization: org,
          memberCount: 0,
        },
      ].sort((x, y) => (x.id < y.id ? -1 : 1))
    );
  });

  it("getUserIdsByRoleId skips archived groups and lists each user once", async () => {
    const both = await createTestUser();
    const archivedOnly = await createTestUser();
    const role = await grantingRole();
    await prisma.userRole.create({
      data: { userId: both.id, roleId: role.id },
    });
    await groupWith(null, [both.id], [role.id]);
    await groupWith(null, [both.id], [role.id]);
    const archived = await groupWith(null, [archivedOnly.id], [role.id]);
    await db.groups.setArchived(archived.id, new Date());

    expect(await db.roles.getUserIdsByRoleId(role.id)).toEqual([
      { userId: both.id, user: { oauthClientId: null } },
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

  it("holdsRequires2faRole counts group roles in active member orgs only", async () => {
    const orgA = await newOrg();
    const user = await createTestUser();
    const role = await grantingRole({ requires2fa: true });
    await groupWith(orgA, [user.id], [role.id]);
    // Not yet a member of the group's organization.
    expect(await db.roles.holdsRequires2faRole(user.id)).toBe(false);

    await joinOrg(orgA, user.id);
    expect(await db.roles.holdsRequires2faRole(user.id)).toBe(true);
    expect(
      await prisma.$transaction((tx) =>
        db.roles.holdsRequires2faRole(user.id, tx)
      )
    ).toBe(true);

    await prisma.organization.update({
      where: { id: orgA },
      data: { isActive: false },
    });
    expect(await db.roles.holdsRequires2faRole(user.id)).toBe(false);
  });

  it("holdsRequires2faRole applies the guest floor unless ignoreGuestFloor", async () => {
    const orgA = await newOrg();
    const { user } = await createTestGuest({ organizationId: orgA });
    const role = await grantingRole({ requires2fa: true });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId: orgA },
    });

    expect(await db.roles.holdsRequires2faRole(user.id)).toBe(false);
    expect(
      await db.roles.holdsRequires2faRole(user.id, undefined, {
        ignoreGuestFloor: true,
      })
    ).toBe(true);

    await prisma.role.update({
      where: { id: role.id },
      data: { guestAssignable: true },
    });
    expect(await db.roles.holdsRequires2faRole(user.id)).toBe(true);
  });

  it("a direct role still counts for a user in no group, and in a transaction", async () => {
    const user = await createTestUser();
    const role = await grantingRole();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });

    expect(await db.roles.getUserPermissions(user.id)).toEqual([PERMISSION]);
    expect(
      await prisma.$transaction((tx) =>
        db.roles.getUserPermissions(user.id, null, tx)
      )
    ).toEqual([PERMISSION]);
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

describe("db.roles.getUsersPermissionsAnywhere", () => {
  const perm = async (label: string, orgAssignable = false) => {
    const name = `${TEST_SERVICE.namespace}.reports-union.${label}${run}`;
    const permission = await ensurePermission(name);
    await prisma.permission.update({
      where: { id: permission.id },
      data: { orgAssignable },
    });
    return permission;
  };
  const roleOf = async (...permissionIds: string[]) => {
    const role = await createTestRole();
    await prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({
        roleId: role.id,
        permissionId,
      })),
    });
    return role;
  };
  const assign = (
    userId: string,
    roleId: string,
    extra: { organizationId?: string; expiresAt?: Date } = {}
  ) => prisma.userRole.create({ data: { userId, roleId, ...extra } });

  it("returns the union the per-user path gives, in one query", async () => {
    const org = await newOrg();
    const users: string[] = [];
    const user = async () => {
      const id = (await createTestUser()).id;
      users.push(id);
      return id;
    };

    const direct = await user();
    await assign(direct, (await roleOf((await perm("direct")).id)).id);

    const orgScoped = await user();
    const orgOk = await perm("orgok", true);
    const orgNo = await perm("orgno");
    await assign(orgScoped, (await roleOf(orgOk.id, orgNo.id)).id, {
      organizationId: org,
    });

    const viaGroups = await user();
    await joinOrg(org, viaGroups);
    await groupWith(
      null,
      [viaGroups],
      [(await roleOf((await perm("group")).id)).id]
    );
    await groupWith(
      org,
      [viaGroups],
      [(await roleOf((await perm("orggroup", true)).id)).id]
    );
    await groupWith(
      await newOrg(),
      [viaGroups],
      [(await roleOf((await perm("orgout", true)).id)).id]
    );
    const archived = await groupWith(
      null,
      [viaGroups],
      [(await roleOf((await perm("archgroup")).id)).id]
    );
    await db.groups.setArchived(archived.id, new Date());

    const inactive = await user();
    const inactiveRole = await roleOf((await perm("inactive")).id);
    await prisma.role.update({
      where: { id: inactiveRole.id },
      data: { isActive: false },
    });
    await assign(inactive, inactiveRole.id);

    const excluded = await user();
    const retired = await perm("retired");
    await prisma.permission.update({
      where: { id: retired.id },
      data: { retiredAt: new Date() },
    });
    await assign(excluded, (await roleOf(retired.id)).id);
    const archivedRole = await roleOf((await perm("archrole")).id);
    await prisma.role.update({
      where: { id: archivedRole.id },
      data: { archivedAt: new Date() },
    });
    await assign(excluded, archivedRole.id);
    await assign(excluded, (await roleOf((await perm("expired")).id)).id, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const guestRole = await roleOf((await perm("guest", true)).id);
    const { user: guest } = await createTestGuest({
      organizationId: org,
      roleIds: [guestRole.id],
    });
    users.push(guest.id);

    const service = await user();
    const approved = await perm("approved");
    const unapproved = await perm("unapproved");
    const access = await prisma.serviceAccess.create({
      data: {
        serviceId: TEST_SERVICE.id,
        kind: "role",
        target: `reports-union-${randomUUID()}`,
        approvedPermissionIds: [approved.id],
      },
    });
    await prisma.userRole.create({
      data: {
        userId: service,
        roleId: (await roleOf(approved.id, unapproved.id)).id,
        serviceAccessId: access.id,
      },
    });

    await user();

    const perUser = new Set<string>();
    for (const id of users) {
      for (const p of await db.roles.getUserPermissionsAnywhere(id, undefined, {
        includeInactiveRoles: true,
        ignoreGuestFloor: true,
      })) {
        perUser.add(p);
      }
    }
    const union = await prisma.$transaction((tx) =>
      db.roles.getUsersPermissionsAnywhere(users, tx)
    );
    const ours = (label: string) =>
      `${TEST_SERVICE.namespace}.reports-union.${label}${run}`;

    expect(union).toEqual([...perUser].sort());
    expect(union.filter((p) => p.includes(".reports-union."))).toEqual(
      ["direct", "orgok", "group", "orggroup", "inactive", "guest", "approved"]
        .map(ours)
        .sort()
    );
    await prisma.userRole.deleteMany({ where: { serviceAccessId: access.id } });
    await prisma.serviceAccess.delete({ where: { id: access.id } });
  });

  it("returns nothing for no users", async () => {
    expect(await db.roles.getUsersPermissionsAnywhere([])).toEqual([]);
  });
});
