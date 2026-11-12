import type { Group } from "../../../prisma/generated/client/index.js";
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
  withSlugSuffix,
  type ScimGroupInput,
} from "./groupMapping.js";
import {
  addMembers,
  afterGroupChange,
  archiveGroup,
  createGroup,
  emitGroupEvent,
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID.test(groupId)) throw notFound();
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

/** Applies a member set under the locks. */
const applyMembers = async (
  tx: Tx,
  ctx: ScimContext,
  link: ScimGroupLink,
  desired: string[]
): Promise<GroupChange> => {
  if (desired.length > MAX_GROUP_MEMBERS) {
    throw new BadRequestError(
      "tooMany",
      `A group holds at most ${MAX_GROUP_MEMBERS} members`
    );
  }
  if (desired.length > MAX_MEMBER_CHANGES) {
    throw new BadRequestError(
      "tooMany",
      `A request changes at most ${MAX_MEMBER_CHANGES} memberships`
    );
  }
  const ids = desired.filter((v) => UUID.test(v)).map((v) => v.toLowerCase());
  const change = await addMembers(actorOf(ctx), link.groupId, ids, tx);
  await db.scimGroups.setSkipped(link.id, change.skipped, "not_org_member", tx);
  return change;
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
        const added = await applyMembers(tx, ctx, link, input.members);
        return {
          view: {
            link,
            group: added.group,
            members: await membersOf(created.group.id, tx),
          },
          changes: [created, added],
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
