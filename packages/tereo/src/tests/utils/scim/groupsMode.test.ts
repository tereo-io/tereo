// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, type Prisma } from "../../../utils/db/prisma.js";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { createScimConnection } from "../../support/scim.js";
import { createTestUser } from "../../support/auth/users.js";
import { managedWith } from "../../support/scimUsers.js";
import { AppError } from "../../../utils/errors.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  addMembers,
  archiveGroup,
  createGroup,
  removeFromOrgGroupsTx,
  removeMembers,
  setGroupRoles,
  updateGroup,
  type GroupActor,
} from "../../../utils/groups.js";
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
} from "../../support/groups.js";

const groupIds: string[] = [];

const refusal = async (fn: () => Promise<unknown>): Promise<AppError> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
};

const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  db.$transaction(fn);

type Connection = Awaited<ReturnType<typeof createScimConnection>>;

const scimActor = (c: Connection): GroupActor => ({
  mode: "scim",
  connectionId: c.connectionId,
});

/** A group as the SCIM routes will make one: created in scim mode, then linked. */
const pushedGroup = async (
  c: Connection,
  organizationId: string | null = c.organizationId
) => {
  const { group } = await run(async (tx) => {
    const change = await createGroup(
      scimActor(c),
      { organizationId, slug: groupSlug("scim"), name: "Pushed group" },
      tx
    );
    await db.scimGroups.createLink(
      {
        connectionId: c.connectionId,
        groupId: change.group.id,
        externalId: null,
        displayName: "Pushed group",
      },
      tx
    );
    return change;
  });
  groupIds.push(group.id);
  return group;
};

/** A managed user who is a member of the connection's organization. */
const orgUser = async (c: Connection) => {
  const user = await managedWith(c);
  await joinOrg(c.organizationId, user.id);
  return user;
};

const lastAudit = (groupId: string) =>
  prisma.auditLogEntry.findFirstOrThrow({
    where: { entityType: "Group", entityId: groupId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

let c: Connection;

beforeAll(async () => {
  await ensureDefaultOrganization();
  await ensureGroupPermission();
  c = await createScimConnection();
});

afterAll(async () => {
  await prisma.scimGroup.deleteMany({ where: { groupId: { in: groupIds } } });
  await deleteGroups(groupIds);
});

describe("scim mode", () => {
  it("scim create marks both sources scim and holds no roles", async () => {
    const role = await roleGranting();
    const { group } = await run((tx) =>
      createGroup(
        scimActor(c),
        {
          organizationId: c.organizationId,
          slug: groupSlug("scim"),
          name: "Created",
          roleIds: [role.id],
        },
        tx
      )
    );
    groupIds.push(group.id);

    expect(group.definitionSource).toBe("scim");
    expect(group.membershipSource).toBe("scim");
    expect(group.createdBy).toBe(SYSTEM_USER_ID);
    expect(await db.groups.getRoleIds(group.id)).toEqual([]);
  });

  it("scim add skips a managed user outside the organization and adds the rest", async () => {
    const group = await pushedGroup(c);
    const inside = await orgUser(c);
    const outsider = await managedWith(c);

    const result = await run((tx) =>
      addMembers(scimActor(c), group.id, [inside.id, outsider.id], tx)
    );

    expect(result.added).toEqual([inside.id]);
    expect(result.skipped).toEqual([outsider.id]);
    expect(result.dropped).toBe(0);
    expect(await db.groups.getMemberIds(group.id)).toEqual([inside.id]);
  });

  it("scim add drops an id without a live link", async () => {
    const group = await pushedGroup(c);
    const linked = await orgUser(c);
    const unmanaged = await createTestUser();
    await joinOrg(c.organizationId, unmanaged.id);

    const result = await run((tx) =>
      addMembers(scimActor(c), group.id, [linked.id, unmanaged.id], tx)
    );

    expect(result.dropped).toBe(1);
    expect(result.added).toEqual([linked.id]);
    expect(await db.groups.getMemberIds(group.id)).toEqual([linked.id]);
  });

  it("scim add works on an archived group and notifies nobody", async () => {
    const group = await pushedGroup(c);
    await run((tx) => archiveGroup(PROVISIONING, group.id, tx));
    const user = await orgUser(c);

    const result = await run((tx) =>
      addMembers(scimActor(c), group.id, [user.id], tx)
    );

    expect(result.added).toEqual([user.id]);
    expect(result.affectedUserIds).toEqual([]);
    const renamed = await run((tx) =>
      updateGroup(scimActor(c), group.id, { name: "Renamed" }, tx)
    );
    expect(renamed.group.name).toBe("Renamed");
  });

  it("scim add revokes password-only tokens when the group holds a two-factor role", async () => {
    const role = await roleGranting([GROUP_PERMISSION], { requires2fa: true });
    const group = await pushedGroup(c, null);
    await run((tx) => setGroupRoles(PROVISIONING, group.id, [role.id], tx));
    const user = await managedWith(c);
    const jti = await passwordOnlyToken(user.id);

    const result = await run((tx) =>
      addMembers(scimActor(c), group.id, [user.id], tx)
    );

    expect(result.revokedJtis).toContain(jti);
  });

  it("scim audit entries carry scimConnectionId", async () => {
    const group = await pushedGroup(c);
    expect((await lastAudit(group.id)).metadata).toMatchObject({
      scimConnectionId: c.connectionId,
    });

    const user = await orgUser(c);
    const outsider = await managedWith(c);
    await run((tx) =>
      addMembers(
        scimActor(c),
        group.id,
        [user.id, outsider.id, randomUUID()],
        tx
      )
    );
    expect((await lastAudit(group.id)).metadata).toMatchObject({
      action: "members_added",
      scimConnectionId: c.connectionId,
      skipped: 1,
      dropped: 1,
    });

    await run((tx) => removeMembers(scimActor(c), group.id, [user.id], tx));
    expect((await lastAudit(group.id)).metadata).toMatchObject({
      action: "members_removed",
      scimConnectionId: c.connectionId,
    });

    await run((tx) =>
      updateGroup(scimActor(c), group.id, { name: "Audited" }, tx)
    );
    expect((await lastAudit(group.id)).metadata).toMatchObject({
      scimConnectionId: c.connectionId,
    });

    await run((tx) => archiveGroup(scimActor(c), group.id, tx));
    expect((await lastAudit(group.id)).metadata).toMatchObject({
      scimConnectionId: c.connectionId,
    });
  });
});

describe("scim mode and the last administrator", () => {
  // Other suites leave admins behind: their assignments are set aside for
  // this block.
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

  it("scim remove of the last administrator is refused", async () => {
    const adminPermission = await prisma.permission.findUniqueOrThrow({
      where: { name: "admin" },
    });
    const adminRole = await prisma.role.create({
      data: {
        name: `scim-admin-${randomUUID().slice(0, 8)}`,
        displayName: "Scim test admin",
        rolePermissions: { create: [{ permissionId: adminPermission.id }] },
      },
    });
    const group = await pushedGroup(c, null);
    await run((tx) =>
      setGroupRoles(PROVISIONING, group.id, [adminRole.id], tx)
    );
    const user = await managedWith(c);
    await run((tx) => addMembers(scimActor(c), group.id, [user.id], tx));

    const err = await refusal(() =>
      run((tx) => removeMembers(scimActor(c), group.id, [user.id], tx))
    );

    expect(err.statusCode).toBe(409);
    expect(await db.groups.getMemberIds(group.id)).toEqual([user.id]);
    await prisma.scimGroup.deleteMany({ where: { groupId: group.id } });
    await deleteGroups([group.id]);
  });
});

describe("admin mode on a pushed group", () => {
  it("admin add, remove and rename on a pushed group answer managed_by_scim; slug and description edits succeed", async () => {
    const group = await pushedGroup(c);
    const user = await orgUser(c);
    await run((tx) => addMembers(scimActor(c), group.id, [user.id], tx));
    const admin = await adminActor(["groups.admin", GROUP_PERMISSION]);

    const add = await refusal(() =>
      run((tx) => addMembers(admin, group.id, [user.id], tx))
    );
    const remove = await refusal(() =>
      run((tx) => removeMembers(admin, group.id, [user.id], tx))
    );
    const rename = await refusal(() =>
      run((tx) => updateGroup(admin, group.id, { name: "Mine now" }, tx))
    );
    for (const err of [add, remove, rename]) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("managed_by_scim");
    }

    const slug = groupSlug("edited");
    const edited = await run((tx) =>
      updateGroup(
        admin,
        group.id,
        { slug, description: "Edited by an admin" },
        tx
      )
    );
    expect(edited.group).toMatchObject({
      slug,
      description: "Edited by an admin",
    });
  });

  it("removing a user from the organization records a skipped member on a pushed group", async () => {
    const group = await pushedGroup(c);
    const user = await orgUser(c);
    await run((tx) => addMembers(scimActor(c), group.id, [user.id], tx));

    await run((tx) =>
      removeFromOrgGroupsTx(
        tx,
        { userId: SYSTEM_USER_ID, email: null },
        c.organizationId,
        user.id
      )
    );

    const link = await db.scimGroups.getLinkByGroup(group.id);
    expect(await db.groups.getMemberIds(group.id)).toEqual([]);
    expect(
      await run((tx) => db.scimGroups.listSkippedIds(link!.id, tx))
    ).toEqual([user.id]);
  });
});
