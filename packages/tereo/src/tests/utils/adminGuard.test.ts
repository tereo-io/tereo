// @module-tag int
// @module-tag auth
// @module-tag race

import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { holdLocks, waitForLockWait } from "../support/dbLocks.js";
import { prisma, type Prisma } from "../../utils/db/prisma.js";
import { generateUniqueId } from "../support/auth/crypto.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { createTestUser } from "../support/auth/users.js";
import { removeMembers } from "../../utils/groups.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  assertAdminCanSignInWithout,
  assertAdminRemains,
} from "../../utils/adminGuard.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../support/principals.js";

type Tx = Prisma.TransactionClient;

/**
 * The last-admin guard. Other suites, and other runs sharing the test
 * database, leave admins behind, and this file changes none of their rows.
 * A check that needs the admins made here to be the only ones runs in
 * `asSoleAdmins`: a transaction that sets every other admin aside, runs the
 * check in it, and always rolls back, so no other session ever sees the
 * change. Requests to the server, which cannot see that transaction, only
 * show that each route queues on the guard's lock.
 */
describe("assertAdminRemains", () => {
  const madeUserIds: string[] = [];
  const madeGroupIds: string[] = [];
  let callerToken: string;
  let adminPermissionId: string;

  const grantsAdmin = {
    isActive: true,
    archivedAt: null,
    retiredAt: null,
    rolePermissions: {
      some: { permission: { name: "admin", retiredAt: null } },
    },
  };

  class Rollback extends Error {}

  const asSoleAdmins = async (check: (tx: Tx) => Promise<void>) => {
    await prisma
      .$transaction(
        async (tx) => {
          await tx.userRole.updateMany({
            where: {
              organizationId: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              user: { isActive: true, userType: "human" },
              role: grantsAdmin,
              userId: { notIn: madeUserIds },
            },
            data: { expiresAt: new Date(Date.now() - 60_000) },
          });
          await tx.group.updateMany({
            where: {
              id: { notIn: madeGroupIds },
              organizationId: null,
              archivedAt: null,
              roles: { some: { role: grantsAdmin } },
            },
            data: { archivedAt: new Date() },
          });
          await check(tx);
          throw new Rollback();
        },
        { timeout: 30_000 }
      )
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  };

  const adminRole = async () =>
    prisma.role.create({
      data: {
        name: `guard-admin-${generateUniqueId()}`,
        displayName: "Guard test admin",
        rolePermissions: { create: [{ permissionId: adminPermissionId }] },
      },
    });

  const user = async () => {
    const created = await createTestUser();
    madeUserIds.push(created.id);
    return created;
  };

  const makeAdmin = async () => {
    const admin = await user();
    const role = await adminRole();
    await prisma.userRole.create({
      data: { userId: admin.id, roleId: role.id },
    });
    return { user: admin, role };
  };

  /** A global group holding a fresh admin role, with `size` new members. */
  const adminGroup = async (size: number) => {
    const role = await adminRole();
    const members = [];
    for (let i = 0; i < size; i++) members.push(await user());
    const group = await prisma.group.create({
      data: {
        slug: `guard-${generateUniqueId()}`,
        name: "Guard test group",
        definitionSource: "local",
        createdBy: members[0].id,
      },
    });
    madeGroupIds.push(group.id);
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

  const refusal = (p: Promise<unknown>) =>
    expect(p).rejects.toThrow(/no active administrator/);

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
  });

  // No admin made here outlives its test: the next one's set-aside spares
  // only its own.
  afterEach(async () => {
    await prisma.groupMember.deleteMany({
      where: { groupId: { in: madeGroupIds } },
    });
    await prisma.groupRole.deleteMany({
      where: { groupId: { in: madeGroupIds } },
    });
    await prisma.group.deleteMany({ where: { id: { in: madeGroupIds } } });
    await prisma.userRole.deleteMany({
      where: { userId: { in: madeUserIds } },
    });
    madeGroupIds.length = 0;
    madeUserIds.length = 0;
  });

  it("removing admin-group members passes while another member remains, and refuses the last", async () => {
    const { group, memberIds } = await adminGroup(4);
    const [a, b, c, d] = memberIds;
    await asSoleAdmins(async (tx) => {
      // Several at once, leaving two.
      await removeMembers({ mode: "provisioning" }, group.id, [a, b], tx);
      await removeMembers({ mode: "provisioning" }, group.id, [c], tx);
      await refusal(removeMembers({ mode: "provisioning" }, group.id, [d], tx));
      expect(await tx.groupMember.count({ where: { groupId: group.id } })).toBe(
        1
      );
    });
  });

  it("removing every admin-group member in one call is refused", async () => {
    const { group, memberIds } = await adminGroup(3);
    await asSoleAdmins(async (tx) => {
      await refusal(
        removeMembers({ mode: "provisioning" }, group.id, memberIds, tx)
      );
      expect(await tx.groupMember.count({ where: { groupId: group.id } })).toBe(
        3
      );
    });
  });

  it("weighs each kind of removal against the remaining admins", async () => {
    const { group, role, memberIds } = await adminGroup(2);
    const [a, b] = memberIds;
    const direct = await makeAdmin();
    const orgId = await ensureTestOrganization(`guard-${generateUniqueId()}`);
    await asSoleAdmins(async (tx) => {
      const guard = (removal: Parameters<typeof assertAdminRemains>[0]) =>
        assertAdminRemains(removal, tx);
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

      await tx.userRole.deleteMany({ where: { userId: direct.user.id } });
      expect(await db.roles.adminExists(undefined, tx)).toBe(true);
      await refusal(guard({ kind: "group", groupId: group.id }));
      await refusal(
        guard({ kind: "groupRoles", groupId: group.id, roleIds: [role.id] })
      );
      await refusal(guard({ kind: "role", roleId: role.id }));
      await guard({ kind: "groupMembers", groupId: group.id, userIds: [a] });
      await guard({ kind: "user", userId: b });
      await guard(null);

      // An org group grants no admin outside its organization, nor does an
      // archived group.
      await tx.group.update({
        where: { id: group.id },
        data: { organizationId: orgId },
      });
      expect(await db.roles.adminExists(undefined, tx)).toBe(false);
      await tx.group.update({
        where: { id: group.id },
        data: { organizationId: null, archivedAt: new Date() },
      });
      expect(await db.roles.adminExists(undefined, tx)).toBe(false);
      // With no admin at all there is nothing to protect.
      await guard({ kind: "user", userId: a });
    });
  });

  it("keeping only an expired admin assignment counts as removing admin", async () => {
    const { user: admin } = await makeAdmin();
    const expired = await adminRole();
    await prisma.userRole.create({
      data: {
        userId: admin.id,
        roleId: expired.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await asSoleAdmins((tx) =>
      refusal(
        assertAdminRemains(
          { kind: "directExcept", userId: admin.id, keepRoleIds: [expired.id] },
          tx
        )
      )
    );
  });

  it("removing the last admin's direct assignment passes while a global group grants the same role", async () => {
    const { user: admin, role } = await makeAdmin();
    const group = await prisma.group.create({
      data: {
        slug: `guard-${generateUniqueId()}`,
        name: "Guard test group",
        definitionSource: "local",
        createdBy: admin.id,
      },
    });
    madeGroupIds.push(group.id);
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: admin.id, addedBy: admin.id },
    });
    await prisma.groupRole.create({
      data: { groupId: group.id, roleId: role.id, addedBy: admin.id },
    });
    await asSoleAdmins(async (tx) => {
      await assertAdminRemains(
        { kind: "directExcept", userId: admin.id, keepRoleIds: [] },
        tx
      );
      await assertAdminRemains(
        { kind: "direct", userId: admin.id, roleIds: [role.id] },
        tx
      );
      await refusal(assertAdminRemains({ kind: "role", roleId: role.id }, tx));
    });
  });

  describe("deactivating an identity provider", () => {
    const providerIds: string[] = [];
    const provider = async () => {
      const row = await prisma.identityProvider.create({
        data: {
          slug: `guard-${generateUniqueId().toLowerCase()}`.slice(0, 50),
          displayName: "Guard test provider",
          kind: "oidc",
          issuer: "https://idp.test",
          clientId: "c",
          clientSecret: "s",
          createdBy: SYSTEM_USER_ID,
        },
      });
      providerIds.push(row.id);
      return row;
    };

    afterEach(async () => {
      await prisma.identityProvider.deleteMany({
        where: { id: { in: providerIds } },
      });
      providerIds.length = 0;
    });

    it("is refused when the only administrators sign in through it alone", async () => {
      const { user: admin } = await makeAdmin();
      const [only, other] = [await provider(), await provider()];
      const link = (tx: Tx, providerId: string) =>
        tx.userIdentity.create({
          data: { userId: admin.id, providerId, subject: admin.id },
        });
      const guard = (tx: Tx) => assertAdminCanSignInWithout(only.id, tx);

      await asSoleAdmins(async (tx) => {
        await link(tx, only.id);
        // A password is another way in.
        await guard(tx);
        await tx.user.update({
          where: { id: admin.id },
          data: { passwordHash: null },
        });
        await expect(guard(tx)).rejects.toThrow(
          /no administrator able to sign in/
        );
        // An identity at an inactive provider is no way in; at an active
        // one it is.
        await link(tx, other.id);
        await tx.identityProvider.update({
          where: { id: other.id },
          data: { isActive: false },
        });
        await expect(guard(tx)).rejects.toThrow(
          /no administrator able to sign in/
        );
        await tx.identityProvider.update({
          where: { id: other.id },
          data: { isActive: true },
        });
        await guard(tx);
      });
    });

    it("passes when no administrator could sign in to begin with", async () => {
      const { user: admin } = await makeAdmin();
      const unused = await provider();
      await asSoleAdmins(async (tx) => {
        await tx.user.update({
          where: { id: admin.id },
          data: { passwordHash: null },
        });
        await assertAdminCanSignInWithout(unused.id, tx);
      });
    });

    it("queues on the guard's lock", async () => {
      const row = await provider();
      const release = await holdLocks(
        (tx) =>
          tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`
      );
      const response = fetch(
        `${BASE_URL}/v1/admin/identity-providers/${row.id}/deactivate`,
        { method: "POST", headers: { Authorization: `Bearer ${callerToken}` } }
      );
      try {
        await waitForLockWait("%core:admin-remains%");
      } finally {
        await release();
      }
      expect((await response).status).toBe(HTTP_STATUS.OK);
    });
  });

  it("each route removing admin queues on the guard's lock, so a second removal sees the first", async () => {
    const { group, memberIds } = await adminGroup(2);
    const roles = await makeAdmin();
    const assignment = await makeAdmin();
    const deleted = await adminRole();
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${BASE_URL}/v1/admin${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${callerToken}`,
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const release = await holdLocks(
      (tx) =>
        tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`
    );
    const responses = Promise.all([
      call("DELETE", `/groups/${group.id}/members/${memberIds[0]}`),
      call("PUT", `/users/${roles.user.id}/roles`, { roleIds: [] }),
      call(
        "DELETE",
        `/roles/${assignment.role.id}/users/${assignment.user.id}`
      ),
      call("DELETE", `/roles/${deleted.id}`),
    ]);
    try {
      await waitForLockWait("%core:admin-remains%", 10_000, 4);
    } finally {
      await release();
    }
    // The group's other member remains an admin.
    expect((await responses).map((r) => r.status)).toEqual([
      HTTP_STATUS.NO_CONTENT,
      HTTP_STATUS.OK,
      HTTP_STATUS.NO_CONTENT,
      HTTP_STATUS.NO_CONTENT,
    ]);
  });
});
