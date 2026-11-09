// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { createTestRole, createTestUser } from "../support/auth/users.js";
import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, type Prisma } from "../../utils/db/prisma.js";
import { createTestGuest } from "../support/auth/guests.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { AppError } from "../../utils/errors.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  getTestPrincipalToken,
  ensureTestOrganization,
} from "../support/principals.js";
import {
  addMembers,
  archiveGroup,
  createGroup,
  removeMembers,
  restoreGroup,
  setGroupRoles,
  updateGroup,
} from "../../utils/groups.js";
import {
  adminActor,
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  groupSlug,
  joinOrg,
  passwordOnlyToken,
  PROVISIONING,
  roleGranting,
} from "../support/groups.js";

const groupIds: string[] = [];

const newGroup = async (
  organizationId: string | null,
  roleIds: string[] = [],
  definitionSource: "local" | "provisioned" = "local"
) => {
  const { group } = await db.$transaction((tx) =>
    createGroup(
      PROVISIONING,
      {
        organizationId,
        slug: groupSlug("svc"),
        name: "Service test group",
        roleIds,
        definitionSource,
      },
      tx
    )
  );
  groupIds.push(group.id);
  return group;
};

const newOrg = () => ensureTestOrganization(`group-svc-${randomUUID()}`);

/** The error `fn` throws, so a test can assert its status and code. */
const refusal = async (fn: () => Promise<unknown>): Promise<AppError> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
};

beforeAll(async () => {
  // Events are emitted in-process, under the default organization.
  await ensureDefaultOrganization();
  await ensureGroupPermission();
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

describe("addMembers", () => {
  it("addMembers refuses a guest with guest_not_allowed", async () => {
    const org = await newOrg();
    const group = await newGroup(org);
    const { user: guest } = await createTestGuest({ organizationId: org });

    const err = await refusal(() =>
      db.$transaction((tx) =>
        addMembers(PROVISIONING, group.id, [guest.id], tx)
      )
    );
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("guest_not_allowed");
  });

  it("addMembers refuses a service account with service_account_not_allowed", async () => {
    const group = await newGroup(null);
    const owner = await createTestUser();
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: `group-svc-${randomUUID()}`,
        name: "Group test client",
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        ownerId: owner.id,
      },
    });
    const account = await prisma.user.create({
      data: {
        email: `group-svc-${randomUUID()}@services.example.com`,
        passwordHash: "!",
        userType: "service_account",
        oauthClientId: client.id,
      },
    });

    const err = await refusal(() =>
      db.$transaction((tx) =>
        addMembers(PROVISIONING, group.id, [account.id], tx)
      )
    );
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("service_account_not_allowed");
  });

  it("addMembers refuses the system user", async () => {
    const group = await newGroup(null);
    const err = await refusal(() =>
      db.$transaction((tx) =>
        addMembers(PROVISIONING, group.id, [SYSTEM_USER_ID], tx)
      )
    );
    expect(err.statusCode).toBe(409);
    expect(await db.groups.getMemberIds(group.id)).toEqual([]);
  });

  it("addMembers refuses a non-member of the group's org with not_org_member", async () => {
    const org = await newOrg();
    const group = await newGroup(org);
    const user = await createTestUser();

    const err = await refusal(() =>
      db.$transaction((tx) => addMembers(PROVISIONING, group.id, [user.id], tx))
    );
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("not_org_member");
  });

  it("addMembers refuses an admin-mode caller lacking a group role's permission (403)", async () => {
    const role = await roleGranting();
    const group = await newGroup(null, [role.id]);
    const user = await createTestUser();
    const actor = await adminActor(["groups.write"]);

    const err = await refusal(() =>
      db.$transaction((tx) => addMembers(actor, group.id, [user.id], tx))
    );
    expect(err.statusCode).toBe(403);
    expect(await db.groups.getMemberIds(group.id)).toEqual([]);

    const allowed = await adminActor(["groups.write", GROUP_PERMISSION]);
    const change = await db.$transaction((tx) =>
      addMembers(allowed, group.id, [user.id], tx)
    );
    expect(change.added).toEqual([user.id]);
    expect(change.affectedUserIds).toEqual([user.id]);
  });

  it("an org admin may not add an owner of the group's org", async () => {
    const org = await newOrg();
    const group = await newGroup(org);
    const owner = await createTestUser();
    await joinOrg(org, owner.id, "owner");
    const actor = await adminActor([], "admin");

    const err = await refusal(() =>
      db.$transaction((tx) => addMembers(actor, group.id, [owner.id], tx))
    );
    expect(err.statusCode).toBe(403);
  });
});

describe("removeMembers and the last admin", () => {
  // Other suites leave admins behind: their assignments are set aside (direct
  // ones expired, global groups granting admin archived) for this block.
  const expired = new Map<string, Date | null>();
  const archivedGroups: string[] = [];

  beforeAll(async () => {
    const grantsAdmin = {
      isActive: true,
      archivedAt: null,
      retiredAt: null,
      rolePermissions: {
        some: { permission: { name: "admin", retiredAt: null } },
      },
    } satisfies Prisma.RoleWhereInput;
    const direct = await prisma.userRole.findMany({
      where: {
        organizationId: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        user: { isActive: true, userType: "human" },
        role: grantsAdmin,
      },
    });
    for (const a of direct) {
      expired.set(a.id, a.expiresAt);
      await prisma.userRole.update({
        where: { id: a.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
    }
    const groups = await prisma.group.findMany({
      where: {
        organizationId: null,
        archivedAt: null,
        roles: { some: { role: grantsAdmin } },
      },
    });
    for (const g of groups) {
      archivedGroups.push(g.id);
      await prisma.group.update({
        where: { id: g.id },
        data: { archivedAt: new Date() },
      });
    }
  });

  afterAll(async () => {
    for (const [id, expiresAt] of expired) {
      await prisma.userRole.updateMany({ where: { id }, data: { expiresAt } });
    }
    await prisma.group.updateMany({
      where: { id: { in: archivedGroups } },
      data: { archivedAt: null },
    });
  });

  it("removeMembers refuses removing the last admin held only via a global group (409)", async () => {
    const adminPermission = await prisma.permission.findUniqueOrThrow({
      where: { name: "admin" },
    });
    const adminRole = await prisma.role.create({
      data: {
        name: `group-admin-${randomUUID().slice(0, 8)}`,
        displayName: "Group test admin",
        rolePermissions: { create: [{ permissionId: adminPermission.id }] },
      },
    });
    const user = await createTestUser();
    const group = await newGroup(null, [adminRole.id]);
    await db.$transaction((tx) =>
      addMembers(PROVISIONING, group.id, [user.id], tx)
    );
    // Holds admin, as stripping an admin needs, but as a service account,
    // which the guard does not count.
    const actor = await adminActor(["admin"]);
    await prisma.user.update({
      where: { id: actor.auth.userId },
      data: { userType: "service_account" },
    });

    const err = await refusal(() =>
      db.$transaction((tx) => removeMembers(actor, group.id, [user.id], tx))
    );
    expect(err.statusCode).toBe(409);
    expect(await db.groups.getMemberIds(group.id)).toEqual([user.id]);

    // No admin it granted outlives the test.
    await deleteGroups([group.id]);
  });
});

describe("roles", () => {
  it("setGroupRoles rejects a role with non-org-assignable permissions on an org group", async () => {
    const org = await newOrg();
    const group = await newGroup(org);
    const role = await roleGranting(["groups.read"]);

    const err = await refusal(() =>
      db.$transaction((tx) =>
        setGroupRoles(PROVISIONING, group.id, [role.id], tx)
      )
    );
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("role_not_org_assignable");
  });

  it("setGroupRoles refuses a system role on an org group", async () => {
    const org = await newOrg();
    const orgGroup = await newGroup(org);
    const globalGroup = await newGroup(null);
    const role = await createTestRole({ isSystem: true });
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { name: GROUP_PERMISSION },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });

    const err = await refusal(() =>
      db.$transaction((tx) =>
        setGroupRoles(PROVISIONING, orgGroup.id, [role.id], tx)
      )
    );
    expect(err.statusCode).toBe(403);
    expect(err.message).toContain(
      "System roles cannot be assigned within an organization"
    );
    expect(await db.groups.getRoleIds(orgGroup.id)).toEqual([]);

    const accepted = await db.$transaction((tx) =>
      setGroupRoles(PROVISIONING, globalGroup.id, [role.id], tx)
    );
    expect(accepted.added).toEqual([role.id]);
  });

  it("setGroupRoles refuses an unknown role with unknown_role", async () => {
    const group = await newGroup(null);
    const err = await refusal(() =>
      db.$transaction((tx) =>
        setGroupRoles(PROVISIONING, group.id, [randomUUID()], tx)
      )
    );
    expect(err.code).toBe("unknown_role");
  });

  it("adding a requires2fa role to a group revokes members' password-only access tokens", async () => {
    const user = await createTestUser();
    const group = await newGroup(null);
    await db.$transaction((tx) =>
      addMembers(PROVISIONING, group.id, [user.id], tx)
    );
    const jti = await passwordOnlyToken(user.id);
    const role = await roleGranting([GROUP_PERMISSION], { requires2fa: true });

    const change = await db.$transaction((tx) =>
      setGroupRoles(PROVISIONING, group.id, [role.id], tx)
    );
    expect(change.added).toEqual([role.id]);
    expect(change.revokedJtis).toContain(jti);
    expect(change.affectedUserIds).toEqual([user.id]);
    const token = await prisma.accessToken.findUniqueOrThrow({
      where: { jti },
    });
    expect(token.revokedAt).not.toBeNull();
  });

  it("archiving a group drops members' permissions on the next check", async () => {
    const user = await createTestUser();
    const role = await roleGranting();
    const group = await newGroup(null, [role.id]);
    await db.$transaction((tx) =>
      addMembers(PROVISIONING, group.id, [user.id], tx)
    );
    expect(await db.roles.getUserPermissions(user.id)).toContain(
      GROUP_PERMISSION
    );

    const actor = await adminActor(["groups.archive", GROUP_PERMISSION]);
    const change = await db.$transaction((tx) =>
      archiveGroup(actor, group.id, tx)
    );
    expect(change.affectedUserIds).toEqual([user.id]);
    expect(await db.roles.getUserPermissions(user.id)).not.toContain(
      GROUP_PERMISSION
    );
  });

  it("restoreGroup refuses an org group whose role gained a non-org-assignable permission while archived", async () => {
    const role = await roleGranting();
    const group = await newGroup(await newOrg(), [role.id]);
    await db.$transaction((tx) => archiveGroup(PROVISIONING, group.id, tx));
    const globalOnly = await prisma.permission.findUniqueOrThrow({
      where: { name: "groups.read" },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: globalOnly.id },
    });

    const err = await refusal(() =>
      db.$transaction((tx) => restoreGroup(PROVISIONING, group.id, tx))
    );
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("role_not_org_assignable");
    expect((await db.groups.getAny(group.id)).archivedAt).not.toBeNull();
  });
});

describe("provisioned groups", () => {
  it("provisioned groups refuse updateGroup, setGroupRoles, archive in admin mode; members stay editable", async () => {
    const group = await newGroup(null, [], "provisioned");
    const actor = await adminActor(["groups.admin"]);

    for (const attempt of [
      (tx: Prisma.TransactionClient) =>
        updateGroup(actor, group.id, { name: "Renamed" }, tx),
      (tx: Prisma.TransactionClient) => setGroupRoles(actor, group.id, [], tx),
      (tx: Prisma.TransactionClient) => archiveGroup(actor, group.id, tx),
    ]) {
      const err = await refusal(() => db.$transaction(attempt));
      expect(err.code).toBe("managed_by_provisioning");
    }

    const user = await createTestUser();
    const added = await db.$transaction((tx) =>
      addMembers(actor, group.id, [user.id], tx)
    );
    expect(added.added).toEqual([user.id]);
    const removed = await db.$transaction((tx) =>
      removeMembers(actor, group.id, [user.id], tx)
    );
    expect(removed.removed).toEqual([user.id]);
  });
});

describe("organization membership", () => {
  it("removing a user from an org removes them from its groups, and re-adding them to the org does not restore it", async () => {
    const org = await newOrg();
    const orgGroup = await newGroup(org);
    const globalGroup = await newGroup(null);
    const user = await createTestUser();
    await joinOrg(org, user.id);
    await db.$transaction(async (tx) => {
      await addMembers(PROVISIONING, orgGroup.id, [user.id], tx);
      await addMembers(PROVISIONING, globalGroup.id, [user.id], tx);
    });
    const token = await getTestPrincipalToken({
      permissions: ["organizations.write"],
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const removed = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org}/members/${user.id}`,
      { method: "DELETE", headers }
    );
    expect(removed.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(await db.groups.getMemberIds(orgGroup.id)).toEqual([]);
    expect(await db.groups.getMemberIds(globalGroup.id)).toEqual([user.id]);

    const readded = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org}/members`,
      { method: "POST", headers, body: JSON.stringify({ userId: user.id }) }
    );
    expect(readded.status).toBe(HTTP_STATUS.CREATED);
    expect(await db.groups.getMemberIds(orgGroup.id)).toEqual([]);
  });
});
