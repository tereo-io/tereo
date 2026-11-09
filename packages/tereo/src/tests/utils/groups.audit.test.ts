// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureTestOrganization } from "../support/principals.js";
import { prisma, type Prisma } from "../../utils/db/prisma.js";
import { createTestUser } from "../support/auth/users.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  ensureDefaultOrganization,
  getDefaultOrganizationId,
} from "../../utils/defaultOrganization.js";
import {
  addMembers,
  archiveGroup,
  chunkUserIds,
  createGroup,
  removeFromOrgGroupsTx,
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
  roleGranting,
} from "../support/groups.js";

type Actor = Awaited<ReturnType<typeof adminActor>>;

const groupIds: string[] = [];
let actor: Actor;

interface OutboxEvent {
  organizationId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
}

/**
 * Runs `fn` and returns the events it emitted, read in its own transaction:
 * once committed, the reaper may dispatch and delete them at any time.
 */
const withEvents = <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<{ result: T; events: OutboxEvent[] }> =>
  db.$transaction(async (tx) => {
    const groupEvents = {
      destination: "webhook",
      payload: { path: ["entityType"], equals: "Group" },
    };
    const before = new Set(
      (
        await tx.outbox.findMany({ where: groupEvents, select: { id: true } })
      ).map((r) => r.id)
    );
    const result = await fn(tx);
    const rows = await tx.outbox.findMany({
      where: groupEvents,
      orderBy: { id: "asc" },
    });
    const events = rows
      .filter((r) => !before.has(r.id))
      .map((r) => r.payload as unknown as OutboxEvent);
    return { result, events };
  });

const lastAudit = (groupId: string) =>
  prisma.auditLogEntry.findFirstOrThrow({
    where: { entityType: "Group", entityId: groupId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

const newGroup = async (organizationId: string | null) => {
  const { result, events } = await withEvents((tx) =>
    createGroup(
      actor,
      { organizationId, slug: groupSlug("audit"), name: "Audit group" },
      tx
    )
  );
  groupIds.push(result.group.id);
  return { group: result.group, events };
};

beforeAll(async () => {
  // Events are emitted in-process, under the default organization.
  await ensureDefaultOrganization();
  await ensureGroupPermission();
  actor = await adminActor(["groups.admin", GROUP_PERMISSION]);
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

describe("group audit entries and events", () => {
  it("createGroup writes a CREATE entry and auth.group.created under the default org", async () => {
    const { group, events } = await newGroup(null);

    const entry = await lastAudit(group.id);
    expect(entry.action).toBe("CREATE");
    expect(entry.organizationId).toBeNull();
    expect(entry.userId).toBe(actor.auth.userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "auth.group.created",
      organizationId: getDefaultOrganizationId(),
      entityType: "Group",
      entityId: group.id,
      data: {
        id: group.id,
        slug: group.slug,
        name: "Audit group",
        organizationId: null,
        definitionSource: "local",
        membershipSource: "local",
        unprovisionedAt: null,
      },
    });
  });

  it("an org group's entry and events are under its org", async () => {
    const org = await ensureTestOrganization(`group-audit-${randomUUID()}`);
    const { group, events } = await newGroup(org);

    expect((await lastAudit(group.id)).organizationId).toBe(org);
    expect(events[0]).toMatchObject({
      eventType: "auth.group.created",
      organizationId: org,
      data: { organizationId: org },
    });
  });

  it("updateGroup writes an UPDATE entry with changes and auth.group.updated", async () => {
    const { group } = await newGroup(null);
    const { events } = await withEvents((tx) =>
      updateGroup(actor, group.id, { name: "Renamed" }, tx)
    );

    const entry = await lastAudit(group.id);
    expect(entry.action).toBe("UPDATE");
    expect(entry.changes).toEqual({
      name: { old: "Audit group", new: "Renamed" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "auth.group.updated",
      organizationId: getDefaultOrganizationId(),
      data: { id: group.id, name: "Renamed" },
    });
  });

  it("addMembers writes members_added and auth.group.members-added", async () => {
    const org = await ensureTestOrganization(`group-audit-${randomUUID()}`);
    const { group } = await newGroup(org);
    const user = await createTestUser();
    await joinOrg(org, user.id);
    const { events } = await withEvents((tx) =>
      addMembers(actor, group.id, [user.id], tx)
    );

    const entry = await lastAudit(group.id);
    expect(entry.action).toBe("UPDATE");
    expect(entry.organizationId).toBe(org);
    expect(entry.metadata).toEqual({
      action: "members_added",
      userIds: [user.id],
    });
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "auth.group.members-added",
        organizationId: org,
        entityId: group.id,
        data: { groupId: group.id, organizationId: org, userIds: [user.id] },
      }),
    ]);
  });

  it("removeMembers writes members_removed and auth.group.members-removed", async () => {
    const { group } = await newGroup(null);
    const user = await createTestUser();
    await db.$transaction((tx) => addMembers(actor, group.id, [user.id], tx));
    const { events } = await withEvents((tx) =>
      removeMembers(actor, group.id, [user.id], tx)
    );

    expect((await lastAudit(group.id)).metadata).toEqual({
      action: "members_removed",
      userIds: [user.id],
    });
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "auth.group.members-removed",
        organizationId: getDefaultOrganizationId(),
        data: { groupId: group.id, organizationId: null, userIds: [user.id] },
      }),
    ]);
  });

  it("setGroupRoles writes roles_changed and auth.group.roles-changed", async () => {
    const { group } = await newGroup(null);
    const role = await roleGranting();
    const { events } = await withEvents((tx) =>
      setGroupRoles(actor, group.id, [role.id], tx)
    );

    expect((await lastAudit(group.id)).metadata).toEqual({
      action: "roles_changed",
      roleIds: [role.id],
      added: [role.id],
      removed: [],
    });
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "auth.group.roles-changed",
        organizationId: getDefaultOrganizationId(),
        data: {
          groupId: group.id,
          organizationId: null,
          roleIds: [role.id],
          added: [role.id],
          removed: [],
        },
      }),
    ]);
  });

  it("archiveGroup and restoreGroup write ARCHIVE / RESTORE and their events", async () => {
    const { group } = await newGroup(null);

    const archived = await withEvents((tx) =>
      archiveGroup(actor, group.id, tx)
    );
    expect((await lastAudit(group.id)).action).toBe("ARCHIVE");
    expect(archived.events).toEqual([
      expect.objectContaining({
        eventType: "auth.group.archived",
        organizationId: getDefaultOrganizationId(),
        data: expect.objectContaining({ id: group.id }),
      }),
    ]);

    const restored = await withEvents((tx) =>
      restoreGroup(actor, group.id, tx)
    );
    expect((await lastAudit(group.id)).action).toBe("RESTORE");
    expect(restored.events).toEqual([
      expect.objectContaining({
        eventType: "auth.group.restored",
        data: expect.objectContaining({ id: group.id }),
      }),
    ]);
  });

  it("removeFromOrgGroupsTx takes a leaving member out of every org group, archived ones included", async () => {
    const org = await ensureTestOrganization(`group-audit-${randomUUID()}`);
    const user = await createTestUser();
    await joinOrg(org, user.id);
    const live = (await newGroup(org)).group;
    const archived = (await newGroup(org)).group;
    const untouched = (await newGroup(org)).group;
    const global = (await newGroup(null)).group;
    for (const group of [live, archived, global]) {
      await db.$transaction((tx) => addMembers(actor, group.id, [user.id], tx));
    }
    await db.$transaction((tx) => archiveGroup(actor, archived.id, tx));

    const { result, events } = await withEvents((tx) =>
      removeFromOrgGroupsTx(tx, actor.auth, org, user.id)
    );

    expect([...result].sort()).toEqual([live.id, archived.id].sort());
    for (const group of [live, archived]) {
      expect(await db.groups.getMemberIds(group.id)).toEqual([]);
      const entry = await lastAudit(group.id);
      expect(entry.userId).toBe(actor.auth.userId);
      expect(entry.organizationId).toBe(org);
      expect(entry.metadata).toEqual({
        action: "members_removed",
        userIds: [user.id],
        reason: "organization_member_removed",
      });
    }
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining(
        [live, archived].map((group) =>
          expect.objectContaining({
            eventType: "auth.group.members-removed",
            organizationId: org,
            entityId: group.id,
            data: {
              groupId: group.id,
              organizationId: org,
              userIds: [user.id],
            },
          })
        )
      )
    );
    expect(await db.groups.getMemberIds(global.id)).toEqual([user.id]);
    expect(await db.groups.getMemberIds(untouched.id)).toEqual([]);
  });

  it("members-added splits 2,500 user ids into 3 events", () => {
    const ids = Array.from({ length: 2500 }, () => randomUUID());
    const chunks = chunkUserIds(ids, 1000);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunks.flat()).toEqual(ids);
  });
});
