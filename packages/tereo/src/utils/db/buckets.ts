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

  // Admins see every bucket — org isolation and the ownership/grant filter are both bypassed.
  const and: Prisma.BucketWhereInput[] = [];
  if (!isAdmin) {
    and.push({
      OR: [
        { createdBy: userId },
        { permissions: { some: { userId, revokedAt: null } } },
      ],
    });
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
  return await client.bucket.update({
    where: { id },
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
    include: withRefs,
  });
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
 * Atomically reserve quota for an upload.
 * Increments current_usage_bytes only if the result, with the `expectedSize`s
 * active multipart uploads hold against the quota, does not exceed
 * storage_quota_bytes. `completingUploadId` is the multipart upload this
 * write completes, whose own reservation the write takes up.
 * Throws InsufficientStorageError if the quota would be exceeded.
 */
export const reserveQuota = async (
  id: number,
  sizeBytes: bigint,
  tx: Prisma.TransactionClient,
  completingUploadId?: string
): Promise<void> => {
  // The lock multipart initiates take, so neither this write nor an initiate
  // counts the quota without the other's bytes.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`files:multipart:${id}`}, 0))`;
  const result = await tx.$queryRaw<{ count: bigint }[]>`
    UPDATE "files"."buckets"
    SET "current_usage_bytes" = "current_usage_bytes" + ${sizeBytes}::bigint
    WHERE "id" = ${id}
      AND "deleted_at" IS NULL
      AND (
        "storage_quota_bytes" IS NULL
        OR "current_usage_bytes" + ${sizeBytes}::bigint + (
          SELECT COALESCE(SUM(mu."expected_size"), 0)
          FROM "files"."multipart_uploads" mu
          WHERE mu."bucket_id" = ${id}
            AND mu."completed_at" IS NULL
            AND mu."aborted_at" IS NULL
            AND mu."expires_at" > NOW()
            AND mu."id" IS DISTINCT FROM ${completingUploadId ?? null}::uuid
        ) <= "storage_quota_bytes"
      )
    RETURNING 1 AS count
  `;

  if (result.length === 0) {
    throw new InsufficientStorageError("Storage quota exceeded");
  }
};

/**
 * Refuse, before its body is read, an upload of `declaredBytes` to
 * `objectKey` that `reserveQuota` would refuse once it was stored. In a
 * bucket without versioning an overwrite frees the current version's bytes,
 * so those count as room. A request body is a little larger than the file it
 * carries, so this can only err towards refusing at the quota's very edge.
 */
export const assertUploadMayFit = async (
  id: number,
  objectKey: string,
  declaredBytes: bigint
): Promise<void> => {
  const rows = await prisma.$queryRaw<
    {
      quota: bigint | null;
      usage: bigint;
      versioning_enabled: boolean;
      reserved: bigint;
      replaced: bigint;
    }[]
  >`
    SELECT
      b."storage_quota_bytes" AS "quota",
      b."current_usage_bytes" AS "usage",
      b."versioning_enabled",
      (
        SELECT COALESCE(SUM(mu."expected_size"), 0)
        FROM "files"."multipart_uploads" mu
        WHERE mu."bucket_id" = b."id"
          AND mu."completed_at" IS NULL
          AND mu."aborted_at" IS NULL
          AND mu."expires_at" > NOW()
      )::bigint AS "reserved",
      COALESCE((
        SELECT cb."size_bytes"
        FROM "files"."objects" o
        JOIN "files"."object_versions" ov
          ON ov."object_id" = o."id"
          AND ov."is_current" = true
          AND ov."deleted_at" IS NULL
        JOIN "files"."content_blobs" cb ON cb."hash" = ov."content_blob_hash"
        WHERE o."bucket_id" = b."id"
          AND o."object_key" = ${objectKey}
          AND o."deleted_at" IS NULL
        LIMIT 1
      ), 0)::bigint AS "replaced"
    FROM "files"."buckets" b
    WHERE b."id" = ${id}
  `;
  const row = rows[0];
  if (!row || row.quota === null) return;
  const freed = row.versioning_enabled ? 0n : row.replaced;
  if (row.usage + row.reserved + declaredBytes - freed > row.quota) {
    throw new InsufficientStorageError("Storage quota exceeded");
  }
};
