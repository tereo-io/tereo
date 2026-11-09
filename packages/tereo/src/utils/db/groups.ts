import { ConflictError, NotFoundError } from "../errors.js";
import { uniqueViolationFields } from "../prismaErrors.js";
import { prisma } from "./prisma.js";
import {
  GroupDefinitionSource,
  Prisma,
} from "../../../prisma/generated/client/index.js";

export interface CreateGroupInput {
  organizationId: string | null;
  slug: string;
  name: string;
  description: string | null;
  definitionSource: GroupDefinitionSource;
  createdBy: string;
}

export interface UpdateGroupInput {
  slug?: string;
  name?: string;
  description?: string | null;
  unprovisionedAt?: Date | null;
}

export interface ListGroupsOptions {
  /** A group's organization, or `"global"` for groups with none. */
  organizationId?: string | "global";
  definitionSource?: GroupDefinitionSource;
  /** Archived groups too; without it they are left out. */
  includeArchived?: boolean;
  /** Case-insensitive match on slug or name. */
  q?: string;
  /** The last group id of the previous page. */
  cursor?: string;
  limit: number;
}

const SLUG_TAKEN = "A group with this slug already exists here";

/** The partial unique indexes are the only unique constraints on slugs. */
const slugTaken = (err: unknown): boolean => {
  const fields = uniqueViolationFields(err);
  return fields !== null && fields.some((f) => f.endsWith("slug"));
};

const mapSlugConflict = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (slugTaken(err)) throw new ConflictError(SLUG_TAKEN, "group_slug_taken");
    throw err;
  }
};

/** Operational lookup; archived groups are invisible here. */
export const get = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const group = await db.group.findUnique({
    where: { id, archivedAt: null },
  });
  if (!group) throw new NotFoundError("Group not found");
  return group;
};

/** Admin lookup that also returns archived groups. */
export const getAny = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const group = await db.group.findUnique({ where: { id } });
  if (!group) throw new NotFoundError("Group not found");
  return group;
};

export const list = async (
  opts: ListGroupsOptions,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  const rows = await db.group.findMany({
    where: {
      ...(opts.organizationId === "global"
        ? { organizationId: null }
        : opts.organizationId
          ? { organizationId: opts.organizationId }
          : {}),
      ...(opts.definitionSource
        ? { definitionSource: opts.definitionSource }
        : {}),
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.q
        ? {
            OR: [
              { slug: { contains: opts.q, mode: "insensitive" } },
              { name: { contains: opts.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { id: "asc" },
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > opts.limit;
  return { data: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
};

export const create = (data: CreateGroupInput, tx?: Prisma.TransactionClient) =>
  mapSlugConflict(() => (tx ?? prisma).group.create({ data }));

export const update = (
  id: string,
  data: UpdateGroupInput,
  tx?: Prisma.TransactionClient
) =>
  mapSlugConflict(() => (tx ?? prisma).group.update({ where: { id }, data }));

export const setArchived = (
  id: string,
  archivedAt: Date | null,
  tx?: Prisma.TransactionClient
) => (tx ?? prisma).group.update({ where: { id }, data: { archivedAt } });

/** Serializes writers to one group's members and roles until `tx` ends. */
export const lockGroup = async (id: string, tx: Prisma.TransactionClient) => {
  await tx.$queryRaw`SELECT 1 FROM "auth"."groups" WHERE id = ${id}::uuid FOR UPDATE`;
};

/** Locks several groups' rows, ascending id: the order every such caller takes. */
export const lockGroups = async (
  ids: string[],
  tx: Prisma.TransactionClient
) => {
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT 1 FROM "auth"."groups" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
};

export const getMemberIds = async (
  groupId: string,
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const rows = await (tx ?? prisma).groupMember.findMany({
    where: { groupId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
};

/** Of `userIds`, those who are members of the group. */
export const getMemberIdsAmong = async (
  groupId: string,
  userIds: string[],
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const rows = await (tx ?? prisma).groupMember.findMany({
    where: { groupId, userId: { in: userIds } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
};

export const listMembers = async (
  groupId: string,
  opts: { cursor?: string; limit: number },
  tx?: Prisma.TransactionClient
) => {
  const rows = await (tx ?? prisma).groupMember.findMany({
    // `id > cursor`, not Prisma's cursor: a member removed since the
    // previous page would otherwise end the list.
    where: { groupId, ...(opts.cursor ? { id: { gt: opts.cursor } } : {}) },
    orderBy: { id: "asc" },
    take: opts.limit + 1,
    include: {
      user: { select: { id: true, email: true, name: true, isActive: true } },
    },
  });
  const hasMore = rows.length > opts.limit;
  return { data: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
};

/** Adds those not yet members; returns the ids actually added. */
export const addMembers = async (
  groupId: string,
  userIds: string[],
  addedBy: string,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const existing = new Set(
    (
      await tx.groupMember.findMany({
        where: { groupId, userId: { in: userIds } },
        select: { userId: true },
      })
    ).map((r) => r.userId)
  );
  const toAdd = [...new Set(userIds)].filter((id) => !existing.has(id));
  if (toAdd.length === 0) return [];
  await tx.groupMember.createMany({
    data: toAdd.map((userId) => ({ groupId, userId, addedBy })),
  });
  return toAdd;
};

/** Removes those who are members; returns the ids actually removed. */
export const removeMembers = async (
  groupId: string,
  userIds: string[],
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const present = (
    await tx.groupMember.findMany({
      where: { groupId, userId: { in: userIds } },
      select: { userId: true },
    })
  ).map((r) => r.userId);
  if (present.length === 0) return [];
  await tx.groupMember.deleteMany({
    where: { groupId, userId: { in: present } },
  });
  return present;
};

export const getRoleIds = async (
  groupId: string,
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const rows = await (tx ?? prisma).groupRole.findMany({
    where: { groupId },
    select: { roleId: true },
  });
  return rows.map((r) => r.roleId);
};

/** The groups holding the role, archived ones included. */
export const getIdsHoldingRole = async (
  roleId: string,
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const rows = await (tx ?? prisma).groupRole.findMany({
    where: { roleId },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
};

/** Makes the group's roles exactly `roleIds`; returns what changed. */
export const replaceRoles = async (
  groupId: string,
  roleIds: string[],
  addedBy: string,
  tx: Prisma.TransactionClient
): Promise<{ added: string[]; removed: string[] }> => {
  const current = new Set(await getRoleIds(groupId, tx));
  const wanted = new Set(roleIds);
  const added = [...wanted].filter((id) => !current.has(id)).sort();
  const removed = [...current].filter((id) => !wanted.has(id)).sort();
  if (removed.length > 0) {
    await tx.groupRole.deleteMany({
      where: { groupId, roleId: { in: removed } },
    });
  }
  if (added.length > 0) {
    await tx.groupRole.createMany({
      data: added.map((roleId) => ({ groupId, roleId, addedBy })),
    });
  }
  return { added, removed };
};

/**
 * The groups a user belongs to. `organizationId`: undefined for all of them,
 * null for global groups only, an id for global groups plus that
 * organization's. Archived groups only with `includeArchived`.
 */
export const getUserGroups = (
  userId: string,
  opts: { organizationId?: string | null; includeArchived?: boolean } = {},
  tx?: Prisma.TransactionClient
) =>
  (tx ?? prisma).group.findMany({
    where: {
      members: { some: { userId } },
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.organizationId === undefined
        ? {}
        : opts.organizationId === null
          ? { organizationId: null }
          : {
              OR: [
                { organizationId: null },
                { organizationId: opts.organizationId },
              ],
            }),
    },
    orderBy: { id: "asc" },
  });

/** Ids of the organization's groups the user belongs to, archived included. */
export const getOrgGroupIdsForUser = async (
  orgId: string,
  userId: string,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const rows = await tx.group.findMany({
    where: { organizationId: orgId, members: { some: { userId } } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
};

/** Member counts by group id; a group with no members is absent. */
export const countMembers = async (
  groupIds: string[],
  tx?: Prisma.TransactionClient
): Promise<Map<string, number>> => {
  if (groupIds.length === 0) return new Map();
  const rows = await (tx ?? prisma).groupMember.groupBy({
    by: ["groupId"],
    where: { groupId: { in: groupIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.groupId, r._count._all]));
};

/** Every role the group holds, whatever its state, by name. */
export const listRoles = (groupId: string, tx?: Prisma.TransactionClient) =>
  (tx ?? prisma).role.findMany({
    where: { groupRoles: { some: { groupId } } },
    select: { id: true, name: true, displayName: true, serviceId: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
