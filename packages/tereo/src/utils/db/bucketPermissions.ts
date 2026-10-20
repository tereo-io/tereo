import { Prisma } from "../../../prisma/generated/client/index.js";
import { ConflictError } from "../errors.js";
import { prisma } from "./prisma.js";

export interface CreatePermissionInput {
  bucketId: number;
  userId: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  grantedBy: string;
}

export interface UpdatePermissionInput {
  canRead?: boolean;
  canWrite?: boolean;
  canDelete?: boolean;
}

export interface GetPaginatedOptions {
  bucketId: number;
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
}

export const getByBucketAndUser = async (
  bucketId: number,
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  return await (tx ?? prisma).bucketPermission.findUnique({
    where: { bucketId_userId: { bucketId, userId } },
  });
};

/** The user's active grants on the organization's live buckets. */
export const getActiveInOrganization = async (
  organizationId: string,
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  return await (tx ?? prisma).bucketPermission.findMany({
    where: {
      userId,
      revokedAt: null,
      bucket: { organizationId, deletedAt: null },
    },
    include: {
      bucket: { select: { id: true, name: true, organizationId: true } },
    },
  });
};

export const create = async (
  data: CreatePermissionInput,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  try {
    return await client.bucketPermission.create({ data });
  } catch (err) {
    // A concurrent grant to the same user, past the caller's existence check.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ConflictError("Permission already exists for this user");
    }
    throw err;
  }
};

/** False when the grant was already revoked (by a concurrent revoke). */
export const revoke = async (
  id: number,
  revokedBy: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const client = tx ?? prisma;
  const { count } = await client.bucketPermission.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy },
  });
  return count > 0;
};

/**
 * Re-activate a revoked permission row with fresh flags and grant metadata.
 * Used by the grant flow when the target user had a tombstoned row (we
 * un-revoke rather than creating a duplicate). Null when the row was no
 * longer revoked — a concurrent grant got there first.
 */
export const unrevoke = async (
  id: number,
  data: UpdatePermissionInput & { grantedBy: string },
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  const { count } = await client.bucketPermission.updateMany({
    where: { id, revokedAt: { not: null } },
    data: {
      ...data,
      revokedAt: null,
      revokedBy: null,
      grantedAt: new Date(),
    },
  });
  if (count === 0) return null;
  return await client.bucketPermission.findUniqueOrThrow({ where: { id } });
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { bucketId, take, orderBy, where: filterWhere } = options;

  const where: Prisma.BucketPermissionWhereInput = filterWhere
    ? {
        AND: [
          { bucketId, revokedAt: null },
          filterWhere as Prisma.BucketPermissionWhereInput,
        ],
      }
    : { bucketId, revokedAt: null };

  const rows = await prisma.bucketPermission.findMany({
    where,
    take: take + 1,
    orderBy: orderBy || [{ grantedAt: "desc" }],
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};
