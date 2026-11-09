// @module-tag int
// @module-tag auth
// @module-tag race
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { holdLocks, waitForLockWait } from "../support/dbLocks.js";
import { createTestUser } from "../support/auth/users.js";
import { prisma } from "../../utils/db/prisma.js";
import { AppError } from "../../utils/errors.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  getTestPrincipalToken,
  ensureTestOrganization,
} from "../support/principals.js";
import {
  addMembers,
  createGroup,
  restoreGroup,
  setGroupRoles,
} from "../../utils/groups.js";
import {
  adminActor,
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  groupSlug,
  joinOrg,
  PROVISIONING,
  roleGranting,
} from "../support/groups.js";

const groupIds: string[] = [];

const GROUP_LOCK = `%FROM "auth"."groups"%FOR UPDATE%`;
const AUTHORITY_LOCK = "%pg_advisory_xact_lock%";

const newGroup = async (organizationId: string | null) => {
  const { group } = await db.$transaction((tx) =>
    createGroup(
      PROVISIONING,
      {
        organizationId,
        slug: groupSlug("race"),
        name: "Race group",
        definitionSource: "local",
      },
      tx
    )
  );
  groupIds.push(group.id);
  return group;
};

/** The error a promise rejects with, or null once it resolves. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: unknown) => err
  );

beforeAll(async () => {
  // Events are emitted in-process, under the default organization.
  await ensureDefaultOrganization();
  await ensureGroupPermission();
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

describe("group races", () => {
  it.each([true, false])(
    "setGroupRoles and addMembers queued on one group both apply (addMembers first: %s)",
    async (addFirst) => {
      const group = await newGroup(null);
      const member = await createTestUser();
      const newcomer = await createTestUser();
      await db.$transaction((tx) =>
        addMembers(PROVISIONING, group.id, [member.id], tx)
      );
      const role = await roleGranting();

      const release = await holdLocks((tx) =>
        db.groups.lockGroup(group.id, tx)
      );
      const add = () =>
        db.$transaction((tx) =>
          addMembers(PROVISIONING, group.id, [newcomer.id], tx)
        );
      const set = () =>
        db.$transaction((tx) =>
          setGroupRoles(PROVISIONING, group.id, [role.id], tx)
        );
      // Postgres grants the row lock in the order the two queued for it.
      const [members, roles] = addFirst
        ? await (async () => {
            const a = add();
            await waitForLockWait(GROUP_LOCK, 10_000, 1);
            const s = set();
            await waitForLockWait(GROUP_LOCK, 10_000, 2);
            await release();
            return [await a, await s] as const;
          })()
        : await (async () => {
            const s = set();
            await waitForLockWait(GROUP_LOCK, 10_000, 1);
            const a = add();
            await waitForLockWait(GROUP_LOCK, 10_000, 2);
            await release();
            return [await a, await s] as const;
          })();

      expect(roles.added).toEqual([role.id]);
      expect(members.added).toEqual([newcomer.id]);
      // Added first, the newcomer is a member setGroupRoles locks late (step
      // 3) and tells of the change.
      expect(roles.affectedUserIds).toEqual(
        addFirst ? [member.id, newcomer.id].sort() : [member.id]
      );
      expect(await db.groups.getRoleIds(group.id)).toEqual([role.id]);
      for (const user of [member, newcomer]) {
        expect(await db.roles.getUserPermissions(user.id)).toContain(
          GROUP_PERMISSION
        );
      }
    }
  );

  it.each([true, false])(
    "addMembers and org member removal queued on one user leave no org-group membership (addMembers first: %s)",
    async (addFirst) => {
      const token = await getTestPrincipalToken({
        permissions: ["organizations.write"],
      });
      const org = await ensureTestOrganization(`group-race-${randomUUID()}`);
      const group = await newGroup(org);
      const user = await createTestUser();
      await joinOrg(org, user.id);

      const release = await holdLocks((tx) =>
        db.users.lockAuthority(user.id, tx)
      );
      const add = () =>
        outcome(
          db.$transaction((tx) =>
            addMembers(PROVISIONING, group.id, [user.id], tx)
          )
        );
      const remove = () =>
        fetch(`${BASE_URL}/v1/admin/organizations/${org}/members/${user.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
      const [added, removed] = addFirst
        ? await (async () => {
            const a = add();
            await waitForLockWait(AUTHORITY_LOCK, 10_000, 1);
            const r = remove();
            await waitForLockWait(AUTHORITY_LOCK, 10_000, 2);
            await release();
            return [await a, await r] as const;
          })()
        : await (async () => {
            const r = remove();
            await waitForLockWait(AUTHORITY_LOCK, 10_000, 1);
            const a = add();
            await waitForLockWait(AUTHORITY_LOCK, 10_000, 2);
            await release();
            return [await a, await r] as const;
          })();

      expect(removed.status).toBe(HTTP_STATUS.NO_CONTENT);
      if (addFirst) {
        // Added, then taken out again by the removal's cascade.
        expect(added).toBeNull();
      } else {
        expect(added).toBeInstanceOf(AppError);
        expect((added as AppError).code).toBe("not_org_member");
      }
      expect(await db.groups.getMemberIds(group.id)).toEqual([]);
    }
  );

  it("setGroupRoles removing a role that grants no admin still queues on the admin guard's lock", async () => {
    // Under that lock the role may since have gained admin, as a concurrent
    // permission change gives it; only there is that read exact.
    const group = await newGroup(null);
    const role = await roleGranting();
    await db.$transaction((tx) =>
      setGroupRoles(PROVISIONING, group.id, [role.id], tx)
    );

    const release = await holdLocks(
      (tx) =>
        tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`
    );
    let settled = false;
    const pending = db
      .$transaction((tx) => setGroupRoles(PROVISIONING, group.id, [], tx))
      .finally(() => (settled = true));
    try {
      await waitForLockWait("%core:admin-remains%", 5_000);
      expect(settled).toBe(false);
    } finally {
      await release();
    }
    expect((await pending).removed).toEqual([role.id]);
  });

  describe("restoring an org group against its role gaining a permission no organization may hold", () => {
    const ROLE_UPDATE_LOCK = `%FROM "auth"."roles"%FOR UPDATE%`;
    const ROLE_SHARE_LOCK = `%FROM "auth"."roles"%FOR SHARE%`;

    /** An archived org group holding a fresh org-assignable role. */
    const archivedOrgGroup = async () => {
      const org = await ensureTestOrganization(`group-race-${randomUUID()}`);
      const group = await newGroup(org);
      const role = await roleGranting();
      await db.$transaction((tx) =>
        setGroupRoles(PROVISIONING, group.id, [role.id], tx)
      );
      await prisma.group.update({
        where: { id: group.id },
        data: { archivedAt: new Date() },
      });
      const usersRead = await prisma.permission.findUniqueOrThrow({
        where: { name: "users.read" },
      });
      const permissionIds = [
        ...(
          await prisma.rolePermission.findMany({ where: { roleId: role.id } })
        ).map((rp) => rp.permissionId),
        usersRead.id,
      ];
      return { group, role, permissionIds };
    };

    it("a permission change waiting on the restore's share lock sees the group restored", async () => {
      const { group, role, permissionIds } = await archivedOrgGroup();
      const token = await getTestPrincipalToken({
        permissions: ["roles.admin", "users.read", GROUP_PERMISSION],
      });

      const release = await holdLocks((tx) =>
        restoreGroup(PROVISIONING, group.id, tx)
      );
      const pending = fetch(
        `${BASE_URL}/v1/admin/roles/${role.id}/permissions`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ permissionIds }),
        }
      );
      await waitForLockWait(ROLE_UPDATE_LOCK);
      await release();

      const res = await pending;
      expect(res.status).toBe(HTTP_STATUS.CONFLICT);
      expect(((await res.json()) as { error: string }).error).toBe(
        "role_assigned_in_org"
      );
    });

    it("a restore waiting on the permission change's row lock sees the new permission", async () => {
      const { group, role, permissionIds } = await archivedOrgGroup();

      const release = await holdLocks(async (tx) => {
        await db.roles.lockRoles([role.id], "update", tx);
        await db.roles.setPermissions(role.id, permissionIds, tx);
      });
      const pending = outcome(
        db.$transaction((tx) => restoreGroup(PROVISIONING, group.id, tx))
      );
      await waitForLockWait(ROLE_SHARE_LOCK);
      await release();

      const err = await pending;
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("role_not_org_assignable");
      expect((await db.groups.getAny(group.id)).archivedAt).not.toBeNull();
    });
  });

  it("setGroupRoles refuses a group archived while it waited on the group lock", async () => {
    const group = await newGroup(null);
    const role = await roleGranting();
    const actor = await adminActor(["groups.admin", GROUP_PERMISSION]);

    const release = await holdLocks(async (tx) => {
      await db.groups.lockGroup(group.id, tx);
      await db.groups.setArchived(group.id, new Date(), tx);
    });
    const pending = outcome(
      db.$transaction((tx) => setGroupRoles(actor, group.id, [role.id], tx))
    );
    await waitForLockWait(GROUP_LOCK);
    await release();

    const err = await pending;
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect(await db.groups.getRoleIds(group.id)).toEqual([]);
  });
});
