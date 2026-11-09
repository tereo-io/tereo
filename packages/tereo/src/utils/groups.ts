import { assertMayDisempower } from "../routes/v1/admin/users/user/guards.js";
import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { assertCanGrant, assertCanTakeAway } from "./grants.js";
import type { AuthContext } from "../middleware/auth.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { assertAdminRemains } from "./adminGuard.js";
import { lockOrgOwners } from "./orgRoleAuth.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";
import type {
  Group,
  OrgMemberRole,
} from "../../prisma/generated/client/index.js";
import {
  disconnectTokenSockets,
  notifyUsersRolesChanged,
} from "../websocket/emitters/index.js";
import {
  computeChanges,
  emitTx,
  logAuditTx,
  type AuditLogInput,
} from "./outbox.js";
import {
  AlreadyArchivedError,
  ArchivedError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  ManagedByProvisioningError,
  NotArchivedError,
} from "./errors.js";

/**
 * The one way groups change: the admin API and provisioning both come here,
 * so every guard on direct role grants holds for grants through a group.
 * Callers own the transaction (provisioning applies many changes in one) and
 * call `afterGroupChange` once it commits.
 *
 * Lock order, in each transaction:
 * 1. `lockAuthority` for every user whose authority changes, ascending id:
 *    the users added or removed, or for a change to the group's roles (and
 *    archive and restore) every current member.
 * 2. `lockGroup`.
 * 3. For role changes, archive and restore: the members re-read, and the
 *    authority of any not locked in step 1 locked. Such a user was added by
 *    a transaction that has committed, but another may have locked them
 *    since (step 1 of an add or removal naming them) and now queue on the
 *    group: then each waits on the other, Postgres aborts one side with a
 *    deadlock error (40P01), and that request fails. The window is narrow
 *    and nothing retries it.
 * 4. `lockOrgOwners` when an org admin acts on an org group, then
 *    `assertAdminRemains` last.
 */

type Tx = Prisma.TransactionClient;

export type AuditActor = AuditLogInput["auth"];

export type GroupActor =
  | {
      mode: "admin";
      auth: AuthContext;
      /** What the caller may grant in the group's scope. */
      grantable: string[];
      /** The caller's membership role in the group's org, when they act as one. */
      callerOrgRole: OrgMemberRole | null;
    }
  | { mode: "provisioning" };

export interface GroupChange {
  group: Group;
  /** Members whose effective roles changed; notified after commit. */
  affectedUserIds: string[];
  /** Access tokens revoked for a newly required second factor. */
  revokedJtis: string[];
}

export interface CreateGroupInput {
  organizationId: string | null;
  slug: string;
  name: string;
  description?: string | null;
  roleIds?: string[];
  definitionSource?: "local" | "provisioned";
}

export interface UpdateGroupPatch {
  slug?: string;
  name?: string;
  description?: string | null;
}

const MEMBERS_PER_EVENT = 1000;

const SYSTEM_ACTOR: AuditActor = { userId: SYSTEM_USER_ID, email: null };

const auditActor = (actor: GroupActor): AuditActor =>
  actor.mode === "admin" ? actor.auth : SYSTEM_ACTOR;

const actorUserId = (actor: GroupActor): string =>
  actor.mode === "admin" ? actor.auth.userId : SYSTEM_USER_ID;

const unique = (ids: string[]): string[] => [...new Set(ids)].sort();

/** Splits user ids into event-sized pieces. */
export const chunkUserIds = (ids: string[], size: number): string[][] => {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
};

const rolePermissions = {
  rolePermissions: {
    include: {
      permission: {
        select: { name: true, retiredAt: true, orgAssignable: true },
      },
    },
  },
} as const;

/** Every role the group holds, whatever its state: one may come back. */
const groupRoles = (groupId: string, tx: Tx) =>
  tx.role.findMany({
    where: { groupRoles: { some: { groupId } } },
    include: rolePermissions,
  });

const requiresLive2fa = (
  roles: {
    requires2fa: boolean;
    isActive: boolean;
    archivedAt: Date | null;
    retiredAt: Date | null;
  }[]
) =>
  roles.some(
    (r) => r.requires2fa && r.isActive && !r.archivedAt && !r.retiredAt
  );

const lockUsers = async (ids: Iterable<string>, tx: Tx) => {
  for (const id of [...new Set(ids)].sort()) {
    await db.users.lockAuthority(id, tx);
  }
};

/** Lock step 1 for a change to every member: returns those locked. */
const lockCurrentMembers = async (groupId: string, tx: Tx) => {
  const locked = new Set(await db.groups.getMemberIds(groupId, tx));
  await lockUsers(locked, tx);
  return locked;
};

/** Lock step 3: the members as of the group lock, all of them locked. */
const lockLateMembers = async (
  groupId: string,
  locked: Set<string>,
  tx: Tx
): Promise<string[]> => {
  const members = await db.groups.getMemberIds(groupId, tx);
  await lockUsers(
    members.filter((id) => !locked.has(id)),
    tx
  );
  return members.sort();
};

const assertNotProvisioned = (actor: GroupActor, group: Group) => {
  if (actor.mode === "admin" && group.definitionSource === "provisioned") {
    throw new ManagedByProvisioningError(
      "This group is managed by provisioning; change it in the provisioning documents"
    );
  }
};

/**
 * Lock step 4 for an org admin: an organization's owners are changed only by
 * its owners or the platform, so an org admin may not move one in or out of
 * the org's groups.
 */
const assertOrgAdminSparesOwners = async (
  actor: GroupActor,
  group: Group,
  userIds: string[],
  tx: Tx
) => {
  if (
    actor.mode !== "admin" ||
    actor.callerOrgRole !== "admin" ||
    !group.organizationId
  ) {
    return;
  }
  await lockOrgOwners(tx, group.organizationId);
  const owners = await tx.organizationMember.count({
    where: {
      organizationId: group.organizationId,
      userId: { in: userIds },
      memberRole: "owner",
    },
  });
  if (owners > 0) {
    throw new ForbiddenError(
      "Only organization owners can add or remove an owner in the organization's groups"
    );
  }
};

/**
 * Checks roles about to be added to `group`: live, org-assignable for an org
 * group, and (for an admin) only what the caller may grant.
 */
const checkAddedRoles = async (
  actor: GroupActor,
  group: Group,
  roleIds: string[],
  tx: Tx
) => {
  const roles = await db.roles.getByIds(roleIds, tx);
  const found = new Set(roles.map((r) => r.id));
  const missing = roleIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BadRequestError(
      "unknown_role",
      `Roles not found, archived or retired: ${missing.join(", ")}`
    );
  }
  if (group.organizationId) {
    // As for direct org-scoped assignment (utils/orgRoleAssignment.ts): a
    // system role's platform-wide permissions are a path to platform admin.
    const systemRoles = roles.filter((r) => r.serviceId !== null);
    if (systemRoles.length > 0) {
      throw new ForbiddenError(
        `System roles cannot be assigned within an organization: ${systemRoles
          .map((r) => r.name)
          .join(", ")}`
      );
    }
    const notAssignable = db.roles.notOrgAssignablePermissionNames(roles);
    if (notAssignable.length > 0) {
      throw new BadRequestError(
        "role_not_org_assignable",
        `An organization's group cannot hold roles with these permissions: ${notAssignable.join(", ")}`
      );
    }
  }
  if (actor.mode === "admin") {
    assertCanGrant(actor.grantable, db.roles.grantedPermissionNames(roles));
  }
  return roles;
};

const eventOrganizationId = (group: Group) =>
  group.organizationId ?? getDefaultOrganizationId();

const groupData = (group: Group) => ({
  id: group.id,
  slug: group.slug,
  name: group.name,
  organizationId: group.organizationId,
  definitionSource: group.definitionSource,
  membershipSource: group.membershipSource,
  unprovisionedAt: group.unprovisionedAt,
});

export const emitGroupEvent = (
  tx: Tx,
  group: Group,
  eventType:
    | "auth.group.created"
    | "auth.group.updated"
    | "auth.group.archived"
    | "auth.group.restored"
) =>
  emitTx(tx, {
    organizationId: eventOrganizationId(group),
    eventType,
    entityType: "Group",
    entityId: group.id,
    data: groupData(group),
  });

const emitMembersEvents = async (
  tx: Tx,
  group: Group,
  eventType: "auth.group.members-added" | "auth.group.members-removed",
  userIds: string[]
) => {
  for (const chunk of chunkUserIds(userIds, MEMBERS_PER_EVENT)) {
    await emitTx(tx, {
      organizationId: eventOrganizationId(group),
      eventType,
      entityType: "Group",
      entityId: group.id,
      data: {
        groupId: group.id,
        organizationId: group.organizationId,
        userIds: chunk,
      },
    });
  }
};

const emitRolesChanged = (
  tx: Tx,
  group: Group,
  roleIds: string[],
  added: string[],
  removed: string[]
) =>
  emitTx(tx, {
    organizationId: eventOrganizationId(group),
    eventType: "auth.group.roles-changed",
    entityType: "Group",
    entityId: group.id,
    data: {
      groupId: group.id,
      organizationId: group.organizationId,
      roleIds,
      added,
      removed,
    },
  });

const membersAudit = (
  tx: Tx,
  auth: AuditActor,
  group: Group,
  action: "members_added" | "members_removed",
  userIds: string[],
  extra: Record<string, unknown> = {}
) =>
  logAuditTx(tx, {
    auth,
    organizationId: group.organizationId,
    action: "UPDATE",
    entityType: "Group",
    entityId: group.id,
    entityName: group.slug,
    metadata: { action, userIds, ...extra },
  });

export const createGroup = async (
  actor: GroupActor,
  input: CreateGroupInput,
  tx: Tx
): Promise<GroupChange> => {
  if (input.organizationId) {
    const org = await tx.organization.findUnique({
      where: { id: input.organizationId },
      select: { archivedAt: true },
    });
    if (!org || org.archivedAt) {
      throw new BadRequestError(
        "unknown_organization",
        `Organization not found or archived: ${input.organizationId}`
      );
    }
  }
  const createdBy = actorUserId(actor);
  // Only provisioning makes provisioned groups.
  const definitionSource =
    actor.mode === "admin"
      ? "local"
      : (input.definitionSource ?? "provisioned");
  const group = await db.groups.create(
    {
      organizationId: input.organizationId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      definitionSource,
      createdBy,
    },
    tx
  );
  const roleIds = unique(input.roleIds ?? []);
  if (roleIds.length > 0) {
    await checkAddedRoles(actor, group, roleIds, tx);
    await db.groups.replaceRoles(group.id, roleIds, createdBy, tx);
  }
  await logAuditTx(tx, {
    auth: auditActor(actor),
    organizationId: group.organizationId,
    action: "CREATE",
    entityType: "Group",
    entityId: group.id,
    entityName: group.slug,
    metadata: {
      definitionSource,
      ...(roleIds.length > 0 && { roleIds }),
    },
  });
  await emitGroupEvent(tx, group, "auth.group.created");
  if (roleIds.length > 0) {
    await emitRolesChanged(tx, group, roleIds, roleIds, []);
  }
  return { group, affectedUserIds: [], revokedJtis: [] };
};

const editable = (g: Group) => ({
  slug: g.slug,
  name: g.name,
  description: g.description,
});

export const updateGroup = async (
  actor: GroupActor,
  groupId: string,
  patch: UpdateGroupPatch,
  tx: Tx
): Promise<GroupChange> => {
  await db.groups.lockGroup(groupId, tx);
  const existing = await db.groups.getAny(groupId, tx);
  assertNotProvisioned(actor, existing);
  if (actor.mode === "admin" && existing.archivedAt) {
    throw new ArchivedError("Group is archived; restore it before editing");
  }
  const data = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  ) as UpdateGroupPatch;
  const changes = computeChanges(editable(existing), {
    ...editable(existing),
    ...data,
  });
  if (!changes)
    return { group: existing, affectedUserIds: [], revokedJtis: [] };
  const group = await db.groups.update(groupId, data, tx);
  await logAuditTx(tx, {
    auth: auditActor(actor),
    organizationId: group.organizationId,
    action: "UPDATE",
    entityType: "Group",
    entityId: group.id,
    entityName: group.slug,
    changes,
  });
  await emitGroupEvent(tx, group, "auth.group.updated");
  return { group, affectedUserIds: [], revokedJtis: [] };
};

export const addMembers = async (
  actor: GroupActor,
  groupId: string,
  userIds: string[],
  tx: Tx
): Promise<GroupChange & { added: string[] }> => {
  const ids = unique(userIds);
  await lockUsers(ids, tx);
  await db.groups.lockGroup(groupId, tx);
  const group = await db.groups.getAny(groupId, tx);
  if (group.archivedAt) {
    throw new ArchivedError(
      "Group is archived; restore it before adding members"
    );
  }

  // For an org group, membership first: an id outside the organization is
  // refused the same way whatever it names, so an org admin cannot tell an
  // unknown user, a guest or a service account elsewhere apart.
  if (group.organizationId) {
    const members = new Set(
      (
        await tx.organizationMember.findMany({
          where: { organizationId: group.organizationId, userId: { in: ids } },
          select: { userId: true },
        })
      ).map((m) => m.userId)
    );
    const outside = ids.filter((id) => !members.has(id));
    if (outside.length > 0) {
      throw new ConflictError(
        `Not members of the group's organization: ${outside.join(", ")}`,
        "not_org_member"
      );
    }
  }

  const users = await tx.user.findMany({ where: { id: { in: ids } } });
  const found = new Map(users.map((u) => [u.id, u]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BadRequestError(
      "unknown_user",
      `Unknown users: ${missing.join(", ")}`
    );
  }
  for (const user of users) {
    if (user.id === SYSTEM_USER_ID) {
      throw new ConflictError(
        "Core's system user cannot join a group",
        "system_user_not_allowed"
      );
    }
    if (user.userType === "guest") {
      throw new ConflictError(
        `A guest cannot join a group: ${user.id}`,
        "guest_not_allowed"
      );
    }
    if (user.oauthClientId !== null || user.userType === "service_account") {
      throw new ConflictError(
        `A service's or an integration's account cannot join a group: ${user.id}`,
        "service_account_not_allowed"
      );
    }
  }
  await assertOrgAdminSparesOwners(actor, group, ids, tx);

  const roles = await groupRoles(groupId, tx);
  if (actor.mode === "admin") {
    assertCanGrant(actor.grantable, db.roles.grantedPermissionNames(roles));
  }

  const added = await db.groups.addMembers(
    groupId,
    ids,
    actorUserId(actor),
    tx
  );
  // Permissions are read live, so a token from a password-only login would
  // carry the group's role; revoked, its refresh meets the step-up.
  const revokedJtis =
    added.length > 0 && requiresLive2fa(roles)
      ? await db.accessTokens.revokeWithoutMfa({ id: { in: added } }, tx)
      : [];
  if (added.length > 0) {
    await membersAudit(
      tx,
      auditActor(actor),
      group,
      "members_added",
      added,
      revokedJtis.length > 0 ? { accessTokensRevoked: revokedJtis.length } : {}
    );
    await emitMembersEvents(tx, group, "auth.group.members-added", added);
  }
  return { group, affectedUserIds: added, revokedJtis, added };
};

export const removeMembers = async (
  actor: GroupActor,
  groupId: string,
  userIds: string[],
  tx: Tx
): Promise<GroupChange & { removed: string[] }> => {
  const ids = unique(userIds);
  // A group's organization never changes, so it can be read before the locks.
  const { organizationId } = await db.groups.getAny(groupId, tx);
  await lockUsers(ids, tx);
  // As for direct role removal: a global group's members must hold nothing
  // the caller does not; an org group's roles are checked against what the
  // caller holds in the org, as an org admin holds nothing globally.
  if (actor.mode === "admin" && !organizationId) {
    for (const id of ids) {
      await assertMayDisempower(actor.auth, id, "remove roles from", tx);
    }
  }
  await db.groups.lockGroup(groupId, tx);
  const group = await db.groups.getAny(groupId, tx);
  await assertOrgAdminSparesOwners(actor, group, ids, tx);
  if (actor.mode === "admin" && group.organizationId) {
    assertCanTakeAway(
      actor.grantable,
      db.roles.grantedPermissionNames(await groupRoles(groupId, tx))
    );
  }
  // Only an unarchived global group's roles count as administrators.
  if (!group.organizationId && !group.archivedAt) {
    await assertAdminRemains(
      (a) => !(a.groupId === groupId && ids.includes(a.userId)),
      tx
    );
  }
  const removed = await db.groups.removeMembers(groupId, ids, tx);
  if (removed.length > 0) {
    await membersAudit(
      tx,
      auditActor(actor),
      group,
      "members_removed",
      removed
    );
    await emitMembersEvents(tx, group, "auth.group.members-removed", removed);
  }
  return {
    group,
    affectedUserIds: group.archivedAt ? [] : removed,
    revokedJtis: [],
    removed,
  };
};

export const setGroupRoles = async (
  actor: GroupActor,
  groupId: string,
  roleIds: string[],
  tx: Tx
): Promise<GroupChange & { added: string[]; removed: string[] }> => {
  const before = await db.groups.getAny(groupId, tx);
  assertNotProvisioned(actor, before);
  if (actor.mode === "admin" && before.archivedAt) {
    throw new ArchivedError(
      "Group is archived; restore it before changing its roles"
    );
  }
  const locked = await lockCurrentMembers(groupId, tx);
  await db.groups.lockGroup(groupId, tx);
  const group = await db.groups.getAny(groupId, tx);
  const memberIds = await lockLateMembers(groupId, locked, tx);

  const wanted = unique(roleIds);
  const current = new Set(await db.groups.getRoleIds(groupId, tx));
  const toAdd = wanted.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !wanted.includes(id));
  const addedRoles =
    toAdd.length > 0 ? await checkAddedRoles(actor, group, toAdd, tx) : [];
  if (actor.mode === "admin" && toRemove.length > 0) {
    const removedRoles = await tx.role.findMany({
      where: { id: { in: toRemove } },
      include: rolePermissions,
    });
    assertCanTakeAway(
      actor.grantable,
      db.roles.grantedPermissionNames(removedRoles)
    );
  }
  const live = !group.archivedAt;
  if (live && !group.organizationId && toRemove.length > 0) {
    const removedAdmin = new Set(await db.roles.getAdminRoleIds(toRemove, tx));
    if (removedAdmin.size > 0) {
      await assertAdminRemains(
        (a) => !(a.groupId === groupId && removedAdmin.has(a.roleId)),
        tx
      );
    }
  }

  const { added, removed } = await db.groups.replaceRoles(
    groupId,
    wanted,
    actorUserId(actor),
    tx
  );
  const changed = added.length > 0 || removed.length > 0;
  const revokedJtis =
    live && memberIds.length > 0 && requiresLive2fa(addedRoles)
      ? await db.accessTokens.revokeWithoutMfa({ id: { in: memberIds } }, tx)
      : [];
  if (changed) {
    await logAuditTx(tx, {
      auth: auditActor(actor),
      organizationId: group.organizationId,
      action: "UPDATE",
      entityType: "Group",
      entityId: group.id,
      entityName: group.slug,
      metadata: {
        action: "roles_changed",
        roleIds: wanted,
        added,
        removed,
        ...(revokedJtis.length > 0 && {
          accessTokensRevoked: revokedJtis.length,
        }),
      },
    });
    await emitRolesChanged(tx, group, wanted, added, removed);
  }
  return {
    group,
    affectedUserIds: live && changed ? memberIds : [],
    revokedJtis,
    added,
    removed,
  };
};

/** Archiving takes every role's effect from the members, as removing them would. */
export const archiveGroup = async (
  actor: GroupActor,
  groupId: string,
  tx: Tx
): Promise<GroupChange> => {
  const before = await db.groups.getAny(groupId, tx);
  assertNotProvisioned(actor, before);
  if (before.archivedAt)
    throw new AlreadyArchivedError("Group is already archived");
  const locked = await lockCurrentMembers(groupId, tx);
  await db.groups.lockGroup(groupId, tx);
  const group = await db.groups.getAny(groupId, tx);
  if (group.archivedAt)
    throw new AlreadyArchivedError("Group is already archived");
  const memberIds = await lockLateMembers(groupId, locked, tx);

  if (actor.mode === "admin") {
    assertCanTakeAway(
      actor.grantable,
      db.roles.grantedPermissionNames(await groupRoles(groupId, tx))
    );
  }
  if (!group.organizationId) {
    await assertAdminRemains((a) => a.groupId !== groupId, tx);
  }
  const archived = await db.groups.setArchived(groupId, new Date(), tx);
  await logAuditTx(tx, {
    auth: auditActor(actor),
    organizationId: archived.organizationId,
    action: "ARCHIVE",
    entityType: "Group",
    entityId: archived.id,
    entityName: archived.slug,
  });
  await emitGroupEvent(tx, archived, "auth.group.archived");
  return { group: archived, affectedUserIds: memberIds, revokedJtis: [] };
};

/** Restoring gives the members every role back, as adding them would. */
export const restoreGroup = async (
  actor: GroupActor,
  groupId: string,
  tx: Tx
): Promise<GroupChange> => {
  const before = await db.groups.getAny(groupId, tx);
  assertNotProvisioned(actor, before);
  if (!before.archivedAt) throw new NotArchivedError("Group is not archived");
  const locked = await lockCurrentMembers(groupId, tx);
  await db.groups.lockGroup(groupId, tx);
  const group = await db.groups.getAny(groupId, tx);
  if (!group.archivedAt) throw new NotArchivedError("Group is not archived");
  const memberIds = await lockLateMembers(groupId, locked, tx);

  const roles = await groupRoles(groupId, tx);
  if (actor.mode === "admin") {
    assertCanGrant(actor.grantable, db.roles.grantedPermissionNames(roles));
  }
  const restored = await db.groups.setArchived(groupId, null, tx);
  const revokedJtis =
    memberIds.length > 0 && requiresLive2fa(roles)
      ? await db.accessTokens.revokeWithoutMfa({ id: { in: memberIds } }, tx)
      : [];
  await logAuditTx(tx, {
    auth: auditActor(actor),
    organizationId: restored.organizationId,
    action: "RESTORE",
    entityType: "Group",
    entityId: restored.id,
    entityName: restored.slug,
    ...(revokedJtis.length > 0 && {
      metadata: { accessTokensRevoked: revokedJtis.length },
    }),
  });
  await emitGroupEvent(tx, restored, "auth.group.restored");
  return { group: restored, affectedUserIds: memberIds, revokedJtis };
};

/**
 * Removes a user leaving an organization from that organization's groups,
 * archived ones included: like their org-scoped roles, a membership kept
 * would hand the group's roles back if they were ever re-added. Runs in the
 * removal's transaction, which already holds the user's authority lock; it
 * takes no group lock, since every writer to this user's memberships holds
 * that authority lock first. Returns the ids of the groups left.
 */
export const removeFromOrgGroupsTx = async (
  tx: Tx,
  auth: AuditActor,
  orgId: string,
  userId: string
): Promise<string[]> => {
  const groupIds = await db.groups.getOrgGroupIdsForUser(orgId, userId, tx);
  for (const groupId of groupIds) {
    const group = await db.groups.getAny(groupId, tx);
    const removed = await db.groups.removeMembers(groupId, [userId], tx);
    if (removed.length === 0) continue;
    await membersAudit(tx, auth, group, "members_removed", removed, {
      reason: "organization_member_removed",
    });
    await emitMembersEvents(tx, group, "auth.group.members-removed", removed);
  }
  return groupIds;
};

/** After commit: ends sockets of revoked tokens and tells members to refresh. */
export const afterGroupChange = (
  change: Pick<GroupChange, "affectedUserIds" | "revokedJtis">
): void => {
  if (change.revokedJtis.length > 0) disconnectTokenSockets(change.revokedJtis);
  notifyUsersRolesChanged(change.affectedUserIds);
};
