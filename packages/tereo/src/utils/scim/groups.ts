import type { Group } from "../../../prisma/generated/client/index.js";
import { resolveGroupOps, type GroupPatchOp } from "./groupPatch.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import type { ScimGroupLink } from "../db/scimGroups.js";
import { prisma, type Prisma } from "../db/prisma.js";
import type { ScimGroupFilter } from "./filter.js";
import type { ScimContext } from "./context.js";
import { logAuditTx } from "../outbox.js";
import db from "../db/index.js";
import {
  MAX_GROUP_MEMBERS,
  MAX_MEMBER_CHANGES,
  slugFromDisplayName,
  UUID_SHAPE,
  withSlugSuffix,
  type ScimGroupInput,
} from "./groupMapping.js";
import {
  addMembers,
  afterGroupChange,
  archiveGroup,
  createGroup,
  emitGroupEvent,
  lockMemberAuthorities,
  removeMembers,
  updateGroup,
  type AuditActor,
  type GroupActor,
  type GroupChange,
} from "../groups.js";
import {
  AlreadyArchivedError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors.js";

type Tx = Prisma.TransactionClient;

export interface ScimGroupView {
  link: ScimGroupLink;
  group: Group;
  members?: Array<{ id: string; name: string | null }>;
}

const SYSTEM_ACTOR: AuditActor = { userId: SYSTEM_USER_ID, email: null };
const SLUG_ATTEMPTS = 50;

const notFound = () => new NotFoundError("Group not found");

const actorOf = (ctx: ScimContext): GroupActor => ({
  mode: "scim",
  connectionId: ctx.connection.id,
});

const requireEnabled = (target: string) => {
  if (target === "none") {
    throw new ForbiddenError("Groups are not enabled for this connection");
  }
};

const findLink = async (ctx: ScimContext, groupId: string, tx?: Tx) => {
  if (!UUID_SHAPE.test(groupId)) throw notFound();
  const link = await db.scimGroups.getLinkForConnection(
    ctx.connection.id,
    groupId.toLowerCase(),
    tx
  );
  if (!link) throw notFound();
  return link;
};

const membersOf = async (groupId: string, tx?: Tx) => {
  const rows = await (tx ?? prisma).groupMember.findMany({
    where: { groupId },
    orderBy: { userId: "asc" },
    select: { user: { select: { id: true, name: true } } },
  });
  return rows.map((r) => r.user);
};

interface MemberDiff {
  toAdd: string[];
  toRemove: string[];
}

/** What turns `current` into `desired`; the caps count these, not the request. */
const diffMembers = (current: string[], desired: Set<string>): MemberDiff => {
  const have = new Set(current);
  const diff = {
    toAdd: [...desired].filter((id) => !have.has(id)).sort(),
    toRemove: current.filter((id) => !desired.has(id)).sort(),
  };
  if (diff.toAdd.length + diff.toRemove.length > MAX_MEMBER_CHANGES) {
    throw new BadRequestError(
      "tooMany",
      `A request changes at most ${MAX_MEMBER_CHANGES} memberships`
    );
  }
  if (
    current.length - diff.toRemove.length + diff.toAdd.length >
    MAX_GROUP_MEMBERS
  ) {
    throw new BadRequestError(
      "tooMany",
      `A group holds at most ${MAX_GROUP_MEMBERS} members`
    );
  }
  return diff;
};

const assertRequestSize = (values: string[]) => {
  if (values.length > MAX_GROUP_MEMBERS) {
    throw new BadRequestError(
      "tooMany",
      `A request may name at most ${MAX_GROUP_MEMBERS} members`
    );
  }
};

const uuidSet = (values: string[]) =>
  new Set(values.filter((v) => UUID_SHAPE.test(v)).map((v) => v.toLowerCase()));

interface MemberOutcome {
  changes: GroupChange[];
  membersChanged: boolean;
}

/** Removes, then adds, and records exactly the members `addMembers` skipped. */
const applyDiff = async (
  tx: Tx,
  ctx: ScimContext,
  link: ScimGroupLink,
  { toAdd, toRemove }: MemberDiff,
  recorded: string[]
): Promise<MemberOutcome> => {
  const changes: GroupChange[] = [];
  let membersChanged = false;
  if (toRemove.length > 0) {
    const removed = await removeMembers(
      actorOf(ctx),
      link.groupId,
      toRemove,
      tx
    );
    changes.push(removed);
    membersChanged ||= removed.removed.length > 0;
  }
  let skipped: string[] = [];
  if (toAdd.length > 0) {
    const added = await addMembers(actorOf(ctx), link.groupId, toAdd, tx);
    changes.push(added);
    membersChanged ||= added.added.length > 0;
    skipped = added.skipped;
  }
  await db.scimGroups.setSkipped(
    link.id,
    skipped,
    "not_org_member",
    tx,
    recorded
  );
  return { changes, membersChanged };
};

export const createScimGroup = async (
  ctx: ScimContext,
  input: ScimGroupInput
): Promise<ScimGroupView> => {
  requireEnabled(ctx.connection.groupsTarget);
  const base = slugFromDisplayName(input.displayName);
  for (let n = 1; n <= SLUG_ATTEMPTS; n++) {
    const slug = n === 1 ? base : withSlugSuffix(base, n);
    try {
      const { view, changes } = await db.$transaction(async (tx) => {
        const connection = await db.scim.lockConnection(ctx.connection.id, tx);
        requireEnabled(connection.groupsTarget);
        const created = await createGroup(
          actorOf(ctx),
          {
            organizationId:
              connection.groupsTarget === "organization"
                ? connection.groupsOrganizationId
                : null,
            slug,
            name: input.displayName,
          },
          tx
        );
        const link = await db.scimGroups.createLink(
          {
            connectionId: connection.id,
            groupId: created.group.id,
            externalId: input.externalId,
            displayName: input.displayName,
          },
          tx
        );
        assertRequestSize(input.members);
        const diff = diffMembers([], uuidSet(input.members));
        const applied = await applyDiff(tx, ctx, link, diff, []);
        return {
          view: {
            link: await findLink(ctx, created.group.id, tx),
            group: await db.groups.getAny(created.group.id, tx),
            members: await membersOf(created.group.id, tx),
          },
          changes: [created, ...applied.changes],
        };
      });
      for (const change of changes) afterGroupChange(change);
      return view;
    } catch (err) {
      if (err instanceof ConflictError && err.code === "group_slug_taken") {
        continue;
      }
      throw err;
    }
  }
  throw new ConflictError("No free slug for this group name");
};

export const getScimGroup = async (
  ctx: ScimContext,
  groupId: string,
  opts: { members: boolean }
): Promise<ScimGroupView> => {
  requireEnabled(ctx.connection.groupsTarget);
  const link = await findLink(ctx, groupId);
  const group = await db.groups.getAny(link.groupId);
  return {
    link,
    group,
    ...(opts.members && { members: await membersOf(group.id) }),
  };
};

export const listScimGroups = async (
  ctx: ScimContext,
  query: { filter: ScimGroupFilter; startIndex: number; count: number }
): Promise<{ views: ScimGroupView[]; total: number }> => {
  requireEnabled(ctx.connection.groupsTarget);
  const { links, total } = await db.scimGroups.listLinks(ctx.connection.id, {
    filter: query.filter,
    skip: query.startIndex - 1,
    take: query.count,
  });
  return {
    views: links.map(({ group, ...link }) => ({ link, group })),
    total,
  };
};

/** Makes a linked group local: sources to `local`, link and skipped rows deleted, members kept. Caller holds the group lock. */
export const unlinkScimGroupTx = async (
  tx: Tx,
  auth: AuditActor,
  groupId: string,
  reason: "admin" | "scim_deleted" | "connection_deleted"
): Promise<Group> => {
  const link = await db.scimGroups.getLinkWithProvider(groupId, tx);
  if (!link) throw notFound();
  const group = await db.groups.setSources(
    groupId,
    { definitionSource: "local", membershipSource: "local" },
    tx
  );
  await db.scimGroups.deleteLink(link.id, tx);
  await logAuditTx(tx, {
    auth,
    organizationId: group.organizationId,
    action: "UPDATE",
    entityType: "Group",
    entityId: group.id,
    entityName: group.slug,
    metadata: {
      action: "scim_unlinked",
      reason,
      scimConnectionId: link.connectionId,
      providerId: link.connection.providerId,
    },
  });
  await emitGroupEvent(tx, group, "auth.group.updated");
  return group;
};

export const deleteScimGroup = async (
  ctx: ScimContext,
  groupId: string
): Promise<void> => {
  requireEnabled(ctx.connection.groupsTarget);
  const link = await findLink(ctx, groupId);
  const change = await db.$transaction(async (tx) => {
    let archived: GroupChange | null = null;
    const group = await db.groups.getAny(link.groupId, tx);
    if (!group.archivedAt) {
      try {
        archived = await archiveGroup(actorOf(ctx), link.groupId, tx);
      } catch (err) {
        if (!(err instanceof AlreadyArchivedError)) throw err;
      }
    }
    await db.groups.lockGroup(link.groupId, tx);
    await unlinkScimGroupTx(tx, SYSTEM_ACTOR, link.groupId, "scim_deleted");
    return archived;
  });
  if (change) afterGroupChange(change);
};

const mergeChanges = (group: Group, changes: GroupChange[]): GroupChange => ({
  group,
  affectedUserIds: [...new Set(changes.flatMap((c) => c.affectedUserIds))],
  revokedJtis: changes.flatMap((c) => c.revokedJtis),
});

/**
 * One transaction for a PUT or PATCH. The connection lock comes first, as in
 * `createScimGroup`, so requests on one connection run one after another and
 * each reads the members it diffs against after the previous one committed.
 * Then, in the order the header of `utils/groups.ts` gives: authority locks
 * for every member added or removed in one ascending pass, then the group.
 */
const changeScimGroup = async (
  ctx: ScimContext,
  groupId: string,
  ops: GroupPatchOp[]
): Promise<ScimGroupView> => {
  requireEnabled(ctx.connection.groupsTarget);
  if (ops.length === 0) {
    return await getScimGroup(ctx, groupId, { members: true });
  }
  const { view, changes } = await db.$transaction(async (tx) => {
    const connection = await db.scim.lockConnection(ctx.connection.id, tx);
    requireEnabled(connection.groupsTarget);
    const link = await findLink(ctx, groupId, tx);
    const current = await db.groups.getMemberIds(link.groupId, tx);
    const recorded = await db.scimGroups.listSkippedIds(link.id, tx);
    const plan = resolveGroupOps(ops, current, recorded);
    const diff = diffMembers(current, plan.desired);

    await lockMemberAuthorities([...diff.toAdd, ...diff.toRemove], tx);
    await db.groups.lockGroup(link.groupId, tx);
    // An unlink or delete that committed since the first read leaves nothing to change.
    const locked = await findLink(ctx, groupId, tx);
    const before = await db.groups.getAny(link.groupId, tx);

    const applied = plan.touchesMembers
      ? await applyDiff(tx, ctx, locked, diff, recorded)
      : { changes: [], membersChanged: false };
    const changes: GroupChange[] = [...applied.changes];
    if (plan.displayName !== undefined && plan.displayName !== before.name) {
      changes.push(
        await updateGroup(
          actorOf(ctx),
          link.groupId,
          { name: plan.displayName },
          tx
        )
      );
    }
    const linkData = {
      ...(plan.displayName !== undefined &&
        plan.displayName !== locked.displayName && {
          displayName: plan.displayName,
        }),
      ...(plan.externalId !== undefined &&
        plan.externalId !== locked.externalId && {
          externalId: plan.externalId,
        }),
    };
    if (Object.keys(linkData).length > 0) {
      await db.scimGroups.updateLink(locked.id, linkData, tx);
    } else if (applied.membersChanged) {
      await db.scimGroups.touchLink(locked.id, tx);
    }
    const group = await db.groups.getAny(link.groupId, tx);
    return {
      view: {
        link: await findLink(ctx, groupId, tx),
        group,
        members: await membersOf(group.id, tx),
      },
      changes: [mergeChanges(group, changes)],
    };
  });
  for (const change of changes) afterGroupChange(change);
  return view;
};

export const replaceScimGroup = async (
  ctx: ScimContext,
  groupId: string,
  input: ScimGroupInput
): Promise<ScimGroupView> => {
  assertRequestSize(input.members);
  return await changeScimGroup(ctx, groupId, [
    { kind: "replaceMembers", values: input.members },
    { kind: "displayName", value: input.displayName },
    { kind: "externalId", value: input.externalId },
  ]);
};

export const patchScimGroup = async (
  ctx: ScimContext,
  groupId: string,
  ops: GroupPatchOp[]
): Promise<ScimGroupView> => await changeScimGroup(ctx, groupId, ops);
