import { orgRefSelect, serviceRefSelect, userRefSelect } from "../refs.js";
import { prisma } from "./prisma.js";
import {
  BucketPolicy,
  Prisma,
} from "../../../prisma/generated/client/index.js";
import {
  ConflictError,
  NotFoundError,
  InsufficientStorageError,
} from "../errors.js";

export interface CreateBucketInput {
  name: string;
  description?: string;
  policy: BucketPolicy;
  storageQuotaBytes?: bigint;
  createdBy: string;
  ownerId: string;
  organizationId?: string;
}

export interface UpdateBucketInput {
  description?: string;
  policy?: BucketPolicy;
  storageQuotaBytes?: bigint | null;
  versioningEnabled?: boolean;
  autoThumbnails?: boolean;
  corsConfig?: Prisma.InputJsonValue | null;
  rateLimitConfig?: Prisma.InputJsonValue | null;
}

export interface GetPaginatedOptions {
  userId: string;
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
  isAdmin?: boolean;
}

// What a bucket response names beside its ids.
const withRefs = {
  service: serviceRefSelect,
  creator: userRefSelect,
  owner: userRefSelect,
  organization: orgRefSelect,
} satisfies Prisma.BucketInclude;

export const get = async (id: number) => {
  const bucket = await prisma.bucket.findUnique({
    where: { id, deletedAt: null },
  });
  if (!bucket) throw new NotFoundError("Bucket not found");
  return bucket;
};

// A name is unique among live buckets only (`buckets_live_name_key`): a
// deleted bucket frees its name.
export const checkByName = async (name: string) => {
  return await prisma.bucket.findFirst({ where: { name, deletedAt: null } });
};

export const checkUniqueByName = async (name: string) => {
  if (await checkByName(name)) {
    throw new ConflictError("Bucket already exists");
  }
};

export const getByName = async (name: string) => {
  const bucket = await prisma.bucket.findFirst({
    where: { name, deletedAt: null },
  });
  if (!bucket) throw new NotFoundError("Bucket not found");
  return bucket;
};

export const getByNameWithService = async (name: string) => {
  const bucket = await prisma.bucket.findFirst({
    where: { name, deletedAt: null },
    include: withRefs,
  });
  if (!bucket) throw new NotFoundError("Bucket not found");
  return bucket;
};

export const getPaginated = async (
  options: GetPaginatedOptions & { organizationId?: string }
) => {
  const {
    userId,
    take,
    orderBy,
    where: filterWhere,
    organizationId,
    isAdmin,
  } = options;

  // Admins see every bucket — org isolation and the grant filter are both
  // bypassed. An owner without an active grant no longer sees theirs.
  const and: Prisma.BucketWhereInput[] = [];
  if (!isAdmin) {
    and.push({ permissions: { some: { userId, revokedAt: null } } });
    // Matches the access check: an organization's bucket is only for callers
    // in that organization, so a caller without one sees org-less buckets.
    and.push(
      organizationId
        ? { OR: [{ organizationId }, { organizationId: null }] }
        : { organizationId: null }
    );
  }

  const baseWhere: Prisma.BucketWhereInput = filterWhere
    ? {
        deletedAt: null,
        AND: [...and, filterWhere as Prisma.BucketWhereInput],
      }
    : { deletedAt: null, AND: and };

  // Over-fetch by one to detect hasMore without a count(*)
  const rows = await prisma.bucket.findMany({
    where: baseWhere,
    take: take + 1,
    orderBy,
    include: withRefs,
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};

export const create = async (
  data: CreateBucketInput,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  try {
    return await client.bucket.create({ data, include: withRefs });
  } catch (err) {
    // A concurrent create of the same name, past `checkUniqueByName`.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ConflictError("Bucket already exists");
    }
    throw err;
  }
};

export const update = async (
  id: number,
  data: UpdateBucketInput,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  // Prisma distinguishes "undefined" (don't update) from "null" (set to null);
  // pass through the exact shape so consumers can clear corsConfig / rateLimitConfig.
  const { corsConfig, rateLimitConfig, ...rest } = data;
  // Conditional, so an update racing the bucket's delete can't write to it.
  const { count } = await client.bucket.updateMany({
    where: { id, deletedAt: null },
    data: {
      ...rest,
      ...(corsConfig !== undefined
        ? { corsConfig: corsConfig === null ? Prisma.DbNull : corsConfig }
        : {}),
      ...(rateLimitConfig !== undefined
        ? {
            rateLimitConfig:
              rateLimitConfig === null ? Prisma.DbNull : rateLimitConfig,
          }
        : {}),
      updatedAt: new Date(),
    },
  });
  if (count === 0) throw new NotFoundError("Bucket not found");
  return await client.bucket.findUniqueOrThrow({
    where: { id },
    include: withRefs,
  });
};

/** Set the owner under the bucket's row lock; returns the one it replaced. */
export const setOwner = async (
  id: number,
  ownerId: string,
  tx: Prisma.TransactionClient
) => {
  const [locked] = await tx.$queryRaw<{ owner_id: string }[]>`
    SELECT "owner_id" FROM "files"."buckets"
    WHERE "id" = ${id} AND "deleted_at" IS NULL
    FOR NO KEY UPDATE
  `;
  if (!locked) throw new NotFoundError("Bucket not found");
  const bucket = await tx.bucket.update({
    where: { id },
    data: { ownerId, updatedAt: new Date() },
    include: withRefs,
  });
  return { bucket, previousOwnerId: locked.owner_id };
};

/**
 * Lock the bucket row for an object write and read its versioning setting
 * under that lock. A setting read when the request arrived can be stale by
 * the time a long upload commits; this one can't change before the write
 * does. Taken after the object's lock. Null for a missing bucket.
 */
export const lockForWrite = async (
  id: number,
  tx: Prisma.TransactionClient
) => {
  const rows = await tx.$queryRaw<
    { deleted_at: Date | null; versioning_enabled: boolean }[]
  >`
    SELECT "deleted_at", "versioning_enabled"
    FROM "files"."buckets"
    WHERE "id" = ${id}
    FOR NO KEY UPDATE
  `;
  if (rows.length === 0) return null;
  return {
    deleted: rows[0].deleted_at !== null,
    versioningEnabled: rows[0].versioning_enabled,
  };
};

export const decrementUsage = async (
  id: number,
  sizeBytes: bigint,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  await client.$executeRaw`
    UPDATE "files"."buckets"
    SET "current_usage_bytes" = GREATEST(0, "current_usage_bytes" - ${sizeBytes}::bigint)
    WHERE "id" = ${id}
  `;
};

/**
 * Sum of blob sizes across a bucket's live *current* (non-delete-marker)
 * object versions — the bytes a user would see as "still there" in a listing.
 *
 * In a versioning-enabled bucket `current_usage_bytes` counts both current
 * and historical versions (every live blob ref contributes), so it keeps
 * growing across overwrites and doesn't drop on delete. This helper is the
 * "what's live right now" counterpart, surfaced alongside total usage so the
 * UI can show a Current / History split. The result is computed on demand
 * (no stored counter) so it's always consistent with the underlying rows.
 */
export const getLiveUsageBytes = async (id: number): Promise<bigint> => {
  const rows = await prisma.$queryRaw<{ live_bytes: bigint }[]>`
    SELECT COALESCE(SUM(cb."size_bytes"), 0)::bigint AS "live_bytes"
    FROM "files"."objects" o
    INNER JOIN "files"."object_versions" ov
      ON ov."object_id" = o."id"
      AND ov."is_current" = true
      AND ov."deleted_at" IS NULL
      AND ov."is_delete_marker" = false
    INNER JOIN "files"."content_blobs" cb ON cb."hash" = ov."content_blob_hash"
    WHERE o."bucket_id" = ${id}
      AND o."deleted_at" IS NULL
  `;
  return rows[0]?.live_bytes ?? 0n;
};

/**
 * Deleted buckets, deleted at least `minAgeSeconds` ago, that still have live
 * versions holding blob refs — what `releaseBucketBlobRefsBatch` would
 * release. By id, after `afterId`.
 */
export const listDeletedHoldingRefs = async (
  minAgeSeconds: number,
  limit: number,
  afterId = 0
): Promise<{ id: number; deletedBy: string | null }[]> => {
  return await prisma.$queryRaw<{ id: number; deletedBy: string | null }[]>`
    SELECT b."id", b."deleted_by" AS "deletedBy"
    FROM "files"."buckets" b
    WHERE b."deleted_at" IS NOT NULL
      AND b."deleted_at" < NOW() - (${minAgeSeconds}::int || ' seconds')::interval
      AND b."id" > ${afterId}::int
      AND EXISTS (
        SELECT 1
        FROM "files"."objects" o
        INNER JOIN "files"."object_versions" ov ON ov."object_id" = o."id"
        WHERE o."bucket_id" = b."id"
          AND ov."deleted_at" IS NULL
          AND ov."is_delete_marker" = false
          AND ov."content_blob_hash" IS NOT NULL
      )
    ORDER BY b."id" ASC
    LIMIT ${limit}
  `;
};

/**
 * Atomically reserve quota for an upload.
 * Increments current_usage_bytes only if the result does not exceed storage_quota_bytes.
 * Throws InsufficientStorageError if the quota would be exceeded.
 */
export const reserveQuota = async (
  id: number,
  sizeBytes: bigint,
  tx: Prisma.TransactionClient
): Promise<void> => {
  const result = await tx.$queryRaw<{ count: bigint }[]>`
    UPDATE "files"."buckets"
    SET "current_usage_bytes" = "current_usage_bytes" + ${sizeBytes}::bigint
    WHERE "id" = ${id}
      AND "deleted_at" IS NULL
      AND (
        "storage_quota_bytes" IS NULL
        OR "current_usage_bytes" + ${sizeBytes}::bigint <= "storage_quota_bytes"
      )
    RETURNING 1 AS count
  `;

  if (result.length === 0) {
    throw new InsufficientStorageError("Storage quota exceeded");
  }
};
