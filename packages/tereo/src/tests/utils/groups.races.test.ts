// @module-tag int
// @module-tag auth
// @module-tag race
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { addMembers, createGroup, setGroupRoles } from "../../utils/groups.js";
import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, type Prisma } from "../../utils/db/prisma.js";
import { createTestUser } from "../support/auth/users.js";
import { waitForLockWait } from "../support/dbLocks.js";
import { AppError } from "../../utils/errors.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  getTestPrincipalToken,
  ensureTestOrganization,
} from "../support/principals.js";
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

/**
 * Holds a transaction open after `take` until the returned `release` is
 * called, so the operations started meanwhile queue behind its locks.
 */
const holdLocks = async (
  take: (tx: Prisma.TransactionClient) => Promise<unknown>
) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const isHeld = new Promise<void>((r) => (held = r));
  const done = prisma.$transaction(
    async (tx) => {
      await take(tx);
      held();
      await gate;
    },
    { timeout: 30_000 }
  );
  await isHeld;
  return async () => {
    release();
    await done;
  };
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
