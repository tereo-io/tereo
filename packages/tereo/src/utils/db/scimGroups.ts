import type { ScimGroup } from "../../../prisma/generated/client/index.js";
import type { Prisma } from "../../../prisma/generated/client/index.js";
import type { Group } from "../../../prisma/generated/client/index.js";
import type { ScimGroupFilter } from "../scim/filter.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export type ScimGroupLink = ScimGroup;

type SkipReason = "not_org_member";

export const displayNameKey = (displayName: string): string =>
  displayName.toLowerCase();

export const createLink = async (
  data: {
    connectionId: string;
    groupId: string;
    externalId: string | null;
    displayName: string;
  },
  tx: Tx
): Promise<ScimGroupLink> => {
  return await tx.scimGroup.create({
    data: { ...data, displayNameKey: displayNameKey(data.displayName) },
  });
};

export const getLinkByGroup = async (groupId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimGroup.findUnique({ where: { groupId } });
};

export const getLinkForConnection = async (
  connectionId: string,
  groupId: string,
  tx?: Tx
) => {
  return await (tx ?? prisma).scimGroup.findFirst({
    where: { connectionId, groupId },
  });
};

export const getLinkWithProvider = async (groupId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimGroup.findUnique({
    where: { groupId },
    include: {
      connection: {
        select: {
          providerId: true,
          provider: { select: { displayName: true } },
        },
      },
    },
  });
};

export const updateLink = async (
  id: string,
  data: { externalId?: string | null; displayName?: string },
  tx: Tx
) => {
  return await tx.scimGroup.update({
    where: { id },
    data: {
      ...data,
      ...(data.displayName !== undefined && {
        displayNameKey: displayNameKey(data.displayName),
      }),
    },
  });
};

/** Moves `updated_at` when the group's members change, which `groups.updated_at` does not follow. */
export const touchLink = async (id: string, tx: Tx) => {
  await tx.scimGroup.update({ where: { id }, data: { updatedAt: new Date() } });
};

/** The skipped members cascade. */
export const deleteLink = async (id: string, tx: Tx) => {
  await tx.scimGroup.delete({ where: { id } });
};

export const countLinks = async (connectionId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimGroup.count({ where: { connectionId } });
};

/** Ascending. */
export const listGroupIds = async (
  connectionId: string,
  tx: Tx
): Promise<string[]> => {
  const rows = await tx.scimGroup.findMany({
    where: { connectionId },
    select: { groupId: true },
    orderBy: { groupId: "asc" },
  });
  return rows.map((r) => r.groupId);
};

/** The scope the connection's linked groups share; null when it has none. */
export const linkedScope = async (
  connectionId: string,
  tx: Tx
): Promise<{ organizationId: string | null } | null> => {
  const row = await tx.scimGroup.findFirst({
    where: { connectionId },
    select: { group: { select: { organizationId: true } } },
  });
  return row ? { organizationId: row.group.organizationId } : null;
};

// Each clause is an exact equality; displayName compares the lower-cased key.
const filterWhere = (filter: ScimGroupFilter): Prisma.ScimGroupWhereInput[] =>
  filter.map((clause) =>
    clause.attr === "displayName"
      ? { displayNameKey: displayNameKey(clause.value) }
      : { externalId: clause.value }
  );

export const listLinks = async (
  connectionId: string,
  opts: {
    filter?: ScimGroupFilter;
    skip: number;
    take: number;
  },
  tx?: Tx
): Promise<{
  links: Array<ScimGroupLink & { group: Group }>;
  total: number;
}> => {
  const where: Prisma.ScimGroupWhereInput = {
    connectionId,
    ...(opts.filter?.length && { AND: filterWhere(opts.filter) }),
  };
  const page = {
    where,
    include: { group: true },
    orderBy: { groupId: "asc" },
    skip: opts.skip,
    take: opts.take,
  } as const;
  if (tx) {
    const links = await tx.scimGroup.findMany(page);
    return { links, total: await tx.scimGroup.count({ where }) };
  }
  // One snapshot, so the total and the page agree.
  const [links, total] = await prisma.$transaction([
    prisma.scimGroup.findMany(page),
    prisma.scimGroup.count({ where }),
  ]);
  return { links, total };
};

/** The connection's linked groups the user is a member of. */
export const groupIdsForMember = async (
  connectionId: string,
  userId: string,
  tx: Tx
): Promise<string[]> => {
  const rows = await tx.groupMember.findMany({
    where: { userId, group: { scimLink: { is: { connectionId } } } },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
};

/**
 * Replaces the group's skipped set with exactly `userIds`. With `seen`, only
 * those rows may be deleted: a record written since the caller read them (an
 * organization removal does) stays.
 */
export const setSkipped = async (
  scimGroupId: string,
  userIds: string[],
  reason: SkipReason,
  tx: Tx,
  seen?: string[]
) => {
  const keep = new Set(userIds);
  await tx.scimGroupSkippedMember.deleteMany({
    where: {
      scimGroupId,
      userId: seen
        ? { in: seen.filter((id) => !keep.has(id)) }
        : { notIn: userIds },
    },
  });
  await tx.scimGroupSkippedMember.createMany({
    data: userIds.map((userId) => ({ scimGroupId, userId, reason })),
    skipDuplicates: true,
  });
  await tx.scimGroupSkippedMember.updateMany({
    where: { scimGroupId, userId: { in: userIds } },
    data: { reason },
  });
};

export const addSkipped = async (
  scimGroupId: string,
  userId: string,
  reason: SkipReason,
  tx: Tx
) => {
  await tx.scimGroupSkippedMember.upsert({
    where: { scimGroupId_userId: { scimGroupId, userId } },
    create: { scimGroupId, userId, reason },
    update: { reason },
  });
};

export const listSkippedIds = async (
  scimGroupId: string,
  tx: Tx
): Promise<string[]> => {
  const rows = await tx.scimGroupSkippedMember.findMany({
    where: { scimGroupId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
};

export const clearSkippedForUser = async (
  connectionId: string,
  userId: string,
  tx: Tx
) => {
  await tx.scimGroupSkippedMember.deleteMany({
    where: { userId, scimGroup: { connectionId } },
  });
};

export const countSkipped = async (scimGroupId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimGroupSkippedMember.count({
    where: { scimGroupId },
  });
};

export const listSkipped = async (
  scimGroupId: string,
  opts: { cursor?: string; limit: number }
): Promise<{
  data: Array<{
    userId: string;
    email: string;
    name: string | null;
    reason: string;
    skippedAt: Date;
  }>;
  hasMore: boolean;
  nextCursor: string | null;
}> => {
  const rows = await prisma.scimGroupSkippedMember.findMany({
    where: { scimGroupId },
    include: { user: { select: { email: true, name: true } } },
    orderBy: { id: "asc" },
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  return {
    data: page.map((r) => ({
      userId: r.userId,
      email: r.user.email,
      name: r.user.name,
      reason: r.reason,
      skippedAt: r.createdAt,
    })),
    hasMore,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
};
