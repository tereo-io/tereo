import { ProvisioningError, type ProvisioningSet } from "./load.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { resolveProvisionedRole } from "./roles.js";
import type { GroupEntryOutput } from "./schema.js";
import type { Prisma } from "../db/prisma.js";
import { groupScopeKey } from "./groups.js";
import { logAuditTx } from "../outbox.js";
import { logger } from "../logger.js";
import db from "../db/index.js";
import {
  archiveGroup,
  createGroup,
  emitGroupEvent,
  restoreGroup,
  setGroupRoles,
  updateGroup,
  type GroupActor,
  type GroupChange,
} from "../groups.js";

type Tx = Prisma.TransactionClient;

const PROVISIONING: GroupActor = { mode: "provisioning" };

const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, email: null };

type Changes = Pick<GroupChange, "affectedUserIds" | "revokedJtis">;

const declaredGroups = (set: ProvisioningSet) =>
  set.documents.flatMap(({ file, groups }) =>
    (groups ?? []).map((group) => ({ file, group }))
  );

const groupLabel = (file: string, group: GroupEntryOutput) =>
  `${file}: groups[${group.slug}]`;

const resultEntry = (group: { slug: string; organizationId?: string | null }) =>
  `group:${groupScopeKey(group)}`;

/**
 * Locks the authority of every member of `groupIds`, ascending across all of
 * them: per group, a later group's member locked after an earlier group's row
 * would invert the lock order against an admin holding that member.
 */
const lockMembers = async (tx: Tx, groupIds: string[]): Promise<void> => {
  if (groupIds.length === 0) return;
  const rows = await tx.groupMember.findMany({
    where: { groupId: { in: groupIds } },
    select: { userId: true },
    distinct: ["userId"],
  });
  for (const id of rows.map((r) => r.userId).sort())
    await db.users.lockAuthority(id, tx);
};

/**
 * What the set's groups need from the database before anything is written:
 * their slug in their scope not held by a group made by hand (core never
 * adopts one); for a new group, a live organization; and no group moved to
 * another scope, which is fixed once created.
 */
export const groupProblems = async (
  tx: Tx,
  set: ProvisioningSet
): Promise<string[]> => {
  const declared = declaredGroups(set);
  if (declared.length === 0) return [];
  const orgIds = [
    ...new Set(declared.flatMap(({ group }) => group.organizationId ?? [])),
  ];
  const liveOrgs = new Set(
    (
      await tx.organization.findMany({
        where: { id: { in: orgIds }, archivedAt: null },
        select: { id: true },
      })
    ).map((o) => o.id)
  );
  const rows = await tx.group.findMany({
    where: { slug: { in: declared.map(({ group }) => group.slug) } },
    select: {
      slug: true,
      organizationId: true,
      definitionSource: true,
      unprovisionedAt: true,
      archivedAt: true,
    },
  });
  const declaredKeys = new Set(
    declared.map(({ group }) => groupScopeKey(group))
  );

  const problems: string[] = [];
  for (const { file, group } of declared) {
    const label = groupLabel(file, group);
    const organizationId = group.organizationId ?? null;
    const sameSlug = rows.filter((r) => r.slug === group.slug);
    const own = sameSlug.find((r) => r.organizationId === organizationId);
    if (own?.definitionSource === "local") {
      problems.push(
        `${label}: a group with slug "${group.slug}" already exists here and was not created from the provisioning file`
      );
      continue;
    }
    // As for integrations, the organization is checked on creation only: one
    // archived since leaves its provisioned groups as they are.
    if (own) continue;
    if (organizationId && !liveOrgs.has(organizationId)) {
      problems.push(
        `${label}: organization "${organizationId}" does not exist or is archived`
      );
      continue;
    }
    // A live provisioned group this apply would drop, in another scope.
    const moved = sameSlug.find(
      (r) =>
        r.definitionSource === "provisioned" &&
        !r.archivedAt &&
        !r.unprovisionedAt &&
        !declaredKeys.has(groupScopeKey(r))
    );
    if (moved)
      problems.push(
        `${label}: organizationId cannot change from ${
          moved.organizationId ? `"${moved.organizationId}"` : "none"
        }; the group stays where it was created`
      );
  }
  return problems;
};

/**
 * Creates or brings in line each declared group, once the roles it names
 * exist: name, description and roles, restoring one archived after it was
 * dropped. Members are never touched. Returns what `afterGroupChange` needs
 * once the apply commits.
 */
export const applyGroups = async (
  tx: Tx,
  set: ProvisioningSet,
  now: Date,
  result: { groups: string[] }
): Promise<Changes> => {
  const setRoleNames = new Set(
    set.documents.flatMap((d) => d.roles.map((r) => r.name))
  );
  const problems: string[] = [];
  const resolved: { group: GroupEntryOutput; roleIds: string[] }[] = [];
  for (const { file, group } of declaredGroups(set)) {
    const roleIds: string[] = [];
    for (const name of [...new Set(group.roles)].sort()) {
      const role = await resolveProvisionedRole(tx, name, setRoleNames);
      if (role) roleIds.push(role.id);
      else
        problems.push(
          `${groupLabel(file, group)}: roles "${name}" does not exist in the database, or is archived or retired`
        );
    }
    resolved.push({ group, roleIds });
  }
  if (problems.length > 0) throw new ProvisioningError(problems);

  const affected = new Set<string>();
  const revokedJtis: string[] = [];
  const collect = (change: Changes) => {
    for (const id of change.affectedUserIds) affected.add(id);
    revokedJtis.push(...change.revokedJtis);
  };

  const planned = [];
  for (const { group, roleIds } of resolved) {
    const existing = await tx.group.findFirst({
      where: {
        slug: group.slug,
        organizationId: group.organizationId ?? null,
        definitionSource: "provisioned",
      },
    });
    // setGroupRoles locks every member's authority: skipped when nothing
    // would change, as on most starts.
    const current = new Set(
      existing ? await db.groups.getRoleIds(existing.id, tx) : []
    );
    const wanted = new Set(roleIds);
    const sameRoles =
      current.size === wanted.size &&
      [...wanted].every((id) => current.has(id));
    planned.push({ group, roleIds, existing, sameRoles });
  }
  // Lock step 1 for the whole apply: every member of a group whose roles
  // change or that is restored, ascending, before any group row is written
  // or locked. setGroupRoles and restoreGroup re-enter these locks.
  await lockMembers(
    tx,
    planned.flatMap(({ existing, sameRoles }) =>
      existing && (!sameRoles || existing.archivedAt) ? [existing.id] : []
    )
  );
  // Lock step 2 for the whole apply: every existing group row it or
  // markGroupsMissing may write, ascending, before any group's admin guard.
  // Under the provisioning lock no other writer changes which groups those
  // are.
  await db.groups.lockGroups(
    [
      ...planned.flatMap(({ existing }) => (existing ? [existing.id] : [])),
      ...(await undeclaredLiveGroups(tx, set)).map((g) => g.id),
    ],
    tx
  );

  for (const { group, roleIds, existing, sameRoles } of planned) {
    const organizationId = group.organizationId ?? null;
    const description = group.description ?? null;
    if (!existing) {
      collect(
        await createGroup(
          PROVISIONING,
          {
            organizationId,
            slug: group.slug,
            name: group.name,
            description,
            roleIds,
          },
          tx
        )
      );
      result.groups.push(resultEntry(group));
      continue;
    }

    let changed = false;
    const edited =
      existing.name !== group.name || existing.description !== description;
    if (existing.unprovisionedAt) {
      const back = await db.groups.update(
        existing.id,
        { unprovisionedAt: null },
        tx
      );
      await logAuditTx(tx, {
        auth: SYSTEM_ACTOR,
        organizationId,
        action: "UPDATE",
        entityType: "Group",
        entityId: existing.id,
        entityName: existing.slug,
        changes: {
          unprovisionedAt: { old: existing.unprovisionedAt, new: null },
        },
        metadata: { action: "provisioned" },
      });
      // A restore below announces the return of an archived one, and the
      // edit below that of one renamed or redescribed.
      if (!existing.archivedAt && !edited)
        await emitGroupEvent(tx, back, "auth.group.updated");
      changed = true;
    }
    if (edited) {
      collect(
        await updateGroup(
          PROVISIONING,
          existing.id,
          { name: group.name, description },
          tx
        )
      );
      changed = true;
    }
    if (!sameRoles) {
      const roles = await setGroupRoles(PROVISIONING, existing.id, roleIds, tx);
      collect(roles);
      if (roles.added.length > 0 || roles.removed.length > 0) changed = true;
    }
    if (existing.archivedAt) {
      collect(await restoreGroup(PROVISIONING, existing.id, tx));
      changed = true;
    }
    if (changed) result.groups.push(resultEntry(group));
  }
  return { affectedUserIds: [...affected].sort(), revokedJtis };
};

/** The live provisioned groups the set no longer declares and not yet stamped. */
const undeclaredLiveGroups = async (tx: Tx, set: ProvisioningSet) => {
  const declaredKeys = new Set(
    declaredGroups(set).map(({ group }) => groupScopeKey(group))
  );
  const rows = await tx.group.findMany({
    where: {
      definitionSource: "provisioned",
      unprovisionedAt: null,
      archivedAt: null,
    },
  });
  return rows.filter((row) => !declaredKeys.has(groupScopeKey(row)));
};

/** Stamps `unprovisioned_at` on each provisioned group the set no longer declares. */
export const markGroupsMissing = async (
  tx: Tx,
  set: ProvisioningSet,
  now: Date,
  result: { unprovisioned: string[] }
): Promise<void> => {
  for (const row of await undeclaredLiveGroups(tx, set)) {
    const updated = await db.groups.update(
      row.id,
      { unprovisionedAt: now },
      tx
    );
    await logAuditTx(tx, {
      auth: SYSTEM_ACTOR,
      organizationId: row.organizationId,
      action: "UPDATE",
      entityType: "Group",
      entityId: row.id,
      entityName: row.slug,
      changes: { unprovisionedAt: { old: null, new: now } },
      metadata: { action: "unprovisioned" },
    });
    await emitGroupEvent(tx, updated, "auth.group.updated");
    result.unprovisioned.push(resultEntry(row));
  }
};

/**
 * Archives each group unprovisioned since `cutoff` or before; members stay,
 * so a return restores them. Each group in its own transaction from
 * `inTransaction`, which holds the provisioning lock: one transaction never
 * holds a group's admin-remains lock while it waits on the next group's
 * locks, and a group that fails is logged and left to the next run. Returns
 * the count and the members whose permissions changed, for
 * `afterGroupChange` once committed.
 */
export const archiveDueGroups = async (
  inTransaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  cutoff: Date
): Promise<{ count: number } & Changes> => {
  const dueWhere = {
    definitionSource: "provisioned" as const,
    unprovisionedAt: { lte: cutoff },
    archivedAt: null,
  };
  const due = await inTransaction((tx) =>
    tx.group.findMany({ where: dueWhere, select: { id: true } })
  );
  const affected = new Set<string>();
  let count = 0;
  for (const { id } of due) {
    try {
      const change = await inTransaction(async (tx) => {
        // An apply in between may have declared it again.
        if (!(await tx.group.findFirst({ where: { id, ...dueWhere } }))) {
          return null;
        }
        await lockMembers(tx, [id]);
        return archiveGroup(PROVISIONING, id, tx);
      });
      if (!change) continue;
      count++;
      for (const userId of change.affectedUserIds) affected.add(userId);
    } catch (err) {
      logger.error(
        { err, groupId: id },
        "Provisioning: archiving a dropped group failed"
      );
    }
  }
  return {
    count,
    affectedUserIds: [...affected].sort(),
    revokedJtis: [],
  };
};
