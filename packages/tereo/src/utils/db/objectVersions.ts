import { decrementUsage, lockForWrite, reserveQuota } from "./buckets.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import * as contentBlobs from "./contentBlobs.js";
import { prisma } from "./prisma.js";

export interface CreateVersionInput {
  objectId: string;
  contentBlobHash: string | null;
  etag: string | null;
  contentType: string | null;
  metadata?: Prisma.InputJsonValue;
  tags?: string[];
  createdBy: string;
  isCurrent?: boolean;
  isDeleteMarker?: boolean;
  restoredFromVersionId?: string | null;
}

export interface ListVersionsOptions {
  objectId: string;
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
}

/**
 * Create a version row. Callers are responsible for flipping the prior
 * `isCurrent=true` row (if any) and for calling `contentBlobs.incRef` on the
 * referenced blob when the version is not a delete marker. The `id` UUID is
 * generated client-side by Prisma via `@default(uuid())` on the schema, so
 * callers never pass it in.
 */
export const create = async (
  input: CreateVersionInput,
  tx: Prisma.TransactionClient
) => {
  return await tx.objectVersion.create({
    data: {
      objectId: input.objectId,
      contentBlobHash: input.contentBlobHash,
      etag: input.etag,
      contentType: input.contentType,
      metadata: input.metadata,
      tags: input.tags ?? [],
      isCurrent: input.isCurrent ?? false,
      isDeleteMarker: input.isDeleteMarker ?? false,
      restoredFromVersionId: input.restoredFromVersionId ?? null,
      createdBy: input.createdBy,
    },
  });
};

export const getCurrent = async (
  objectId: string,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.objectVersion.findFirst({
    where: { objectId, isCurrent: true, deletedAt: null },
    include: { contentBlob: true },
  });
};

/**
 * Fetch a specific version of an object by its UUID `id`. Named `getByVersionId`
 * for continuity with the external "versionId" terminology (that is the field
 * name on the wire and in URL paths — the column is simply named `id`).
 */
export const getByVersionId = async (
  objectId: string,
  versionId: string,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  const version = await client.objectVersion.findFirst({
    where: { objectId, id: versionId, deletedAt: null },
    include: { contentBlob: true },
  });
  if (!version) throw new NotFoundError("Version not found");
  return version;
};

export const listPaginated = async (options: ListVersionsOptions) => {
  const baseWhere: Prisma.ObjectVersionWhereInput = {
    objectId: options.objectId,
    deletedAt: null,
  };

  const where: Prisma.ObjectVersionWhereInput = options.where
    ? {
        AND: [baseWhere, options.where as Prisma.ObjectVersionWhereInput],
      }
    : baseWhere;

  const rows = await prisma.objectVersion.findMany({
    where,
    take: options.take + 1,
    orderBy: options.orderBy ?? [{ createdAt: "desc" }],
    include: { contentBlob: true },
  });

  const hasMore = rows.length > options.take;
  const data = hasMore ? rows.slice(0, options.take) : rows;

  return { data, hasMore };
};

/**
 * Does the bucket still hold any non-current, live ObjectVersion rows?
 *
 * A "historical" version is one that still exists (`deletedAt IS NULL`) but
 * is no longer the tip of its Object (`isCurrent = false`). That set includes
 * prior non-current uploads in a versioned bucket and any delete-marker
 * predecessors — i.e. rows that would become unreachable (and lose their
 * blob refs invisibly) if the bucket were flipped back to unversioned.
 *
 * Used by the bucket update controller to refuse `versioningEnabled: false`
 * when the operator has not yet cleared history via lifecycle policy.
 */
export const hasHistoricalVersions = async (
  bucketId: number,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const client = tx ?? prisma;
  const rows = await client.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM "files"."object_versions" ov
      INNER JOIN "files"."objects" o ON o."id" = ov."object_id"
      WHERE o."bucket_id" = ${bucketId}
        AND ov."is_current" = false
        AND ov."deleted_at" IS NULL
    ) AS "exists"
  `;
  return rows[0]?.exists ?? false;
};

/**
 * Flip `isCurrent=false` for every currently-current version of an Object.
 * Used by the restore flow: we need to clear the prior current marker (whether
 * it's a real version or a delete-marker) before inserting the new current.
 */
export const unmarkAllCurrent = async (
  objectId: string,
  tx: Prisma.TransactionClient
) => {
  await tx.objectVersion.updateMany({
    where: { objectId, isCurrent: true },
    data: { isCurrent: false, noncurrentSince: new Date() },
  });
};

/**
 * Mark a single version as soft-deleted. Does NOT touch blob refs — callers
 * that actually want to release the ref must also call `contentBlobs.decRef`
 * in the same transaction, and only when this returns true: false means a
 * concurrent delete got there first and has already released it.
 */
export const markDeleted = async (
  versionId: string,
  deletedBy: string,
  tx: Prisma.TransactionClient
): Promise<boolean> => {
  const { count } = await tx.objectVersion.updateMany({
    where: { id: versionId, deletedAt: null },
    data: { deletedAt: new Date(), deletedBy },
  });
  return count > 0;
};

/**
 * Hard-delete a single version row by primary key. Used by the thumbnail
 * pipeline when it replaces a thumbnail's prior version (no history retained
 * for thumbs).
 */
export const hardDelete = async (
  versionId: string,
  tx: Prisma.TransactionClient
) => {
  await tx.objectVersion.delete({ where: { id: versionId } });
};

/**
 * Update mutable metadata fields (contentType, metadata JSON, tags) on an
 * already-identified version row. Used by the PATCH endpoint to edit the
 * current version's metadata without creating a new version. Omitted fields
 * are left unchanged (Prisma treats `undefined` as "do not set").
 */
export const updateCurrentMetadata = async (
  versionId: string,
  patch: {
    contentType?: string;
    metadata?: Prisma.InputJsonValue;
    tags?: string[];
  },
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  await client.objectVersion.update({
    where: { id: versionId },
    data: {
      contentType: patch.contentType,
      metadata: patch.metadata,
      tags: patch.tags,
    },
  });
};

/**
 * Create a new current version that inherits the current version's content
 * blob (same hash, incRef) while overriding metadata fields the caller
 * supplied. Used by PATCH with `createNewVersion: true` so metadata-only
 * edits on versioned buckets preserve the "every mutation is a version"
 * invariant without duplicating bytes on disk.
 *
 * Assumes the caller has already locked the Object row, then the bucket row
 * (the blob's ref is taken after both). Runs inside the caller's transaction.
 */
export const branchCurrentWithMetadata = async (
  bucketId: number,
  objectId: string,
  patch: {
    contentType?: string;
    metadata?: Prisma.InputJsonValue;
    tags?: string[];
    createdBy: string;
  },
  tx: Prisma.TransactionClient
) => {
  const current = await tx.objectVersion.findFirst({
    where: { objectId, isCurrent: true, deletedAt: null },
    include: { contentBlob: { select: { sizeBytes: true } } },
  });
  if (!current) {
    throw new NotFoundError("Object has no current version to branch from");
  }
  if (current.isDeleteMarker || !current.contentBlobHash) {
    throw new BadRequestError(
      "cannot_branch_delete_marker",
      "Cannot branch a delete marker. Upload new content instead."
    );
  }

  // Flip the prior current off, incRef the shared blob, create the new
  // current with the merged metadata. Like a restore, the new version is
  // charged the blob's size: deleting or expiring either version refunds it.
  await reserveQuota(bucketId, current.contentBlob?.sizeBytes ?? 0n, tx);
  await tx.objectVersion.update({
    where: { id: current.id },
    data: { isCurrent: false, noncurrentSince: new Date() },
  });
  await contentBlobs.incRef(current.contentBlobHash, tx);
  return await tx.objectVersion.create({
    data: {
      objectId,
      contentBlobHash: current.contentBlobHash,
      etag: current.etag,
      contentType: patch.contentType ?? current.contentType,
      metadata:
        patch.metadata !== undefined
          ? patch.metadata
          : ((current.metadata as Prisma.InputJsonValue) ?? undefined),
      tags: patch.tags ?? current.tags,
      isCurrent: true,
      isDeleteMarker: false,
      createdBy: patch.createdBy,
    },
  });
};

/**
 * Soft-delete a non-current version in its own transaction and release the
 * blob ref. Top-level wrapper around `softDelete`; the controller calls
 * this so the tx stays in the db layer.
 */
export const softDeleteVersion = async (
  bucketId: number,
  objectId: string,
  versionId: string,
  deletedBy: string,
  outerTx?: Prisma.TransactionClient
) => {
  const run = (tx: Prisma.TransactionClient) =>
    softDelete(bucketId, objectId, versionId, deletedBy, tx);
  return outerTx ? await run(outerTx) : await prisma.$transaction(run);
};

export interface PurgeNonCurrentResult {
  purgedCount: number;
  releasedBlobHashes: string[];
  /**
   * Sum of `content_blob.size_bytes` across every non-delete-marker version
   * we released. Equivalent to the bucket-usage refund that was applied: in a
   * versioned bucket each retained blob ref contributes to `current_usage_bytes`
   * (see `getLiveUsageBytes` doc), so dropping the ref must subtract the same
   * sizeBytes regardless of whether the blob's refCount reached zero.
   */
  bytesFreed: bigint;
  /** True when the per-request cap was reached and more rows remain. */
  truncated: boolean;
}

/**
 * Soft-delete every non-current, live ObjectVersion row in a bucket. Releases
 * the blob ref for each non-delete-marker version (orphan blobs are then
 * cleaned up by the orphan worker) and refunds the corresponding bucket
 * usage so the UI's Current / Historical / Total split reflects reality.
 * Mirrors the per-tick semantics of the lifecycle sweep's `expireVersions`
 * stage but with no age filter — it's the "I want my history gone now" button.
 *
 * Runs in chunks of `batchSize` rows under their own short transactions so
 * concurrent writes can make progress (`FOR UPDATE SKIP LOCKED`). Stops at
 * `maxTotal` and reports `truncated` so the UI knows to re-invoke.
 */
export const purgeNonCurrentBulk = async (
  bucketId: number,
  deletedBy: string,
  versioningEnabled: boolean,
  opts: {
    batchSize?: number;
    maxTotal?: number;
    /**
     * Runs in each batch's transaction, after its deletes, so the batch's
     * audit entry commits with them.
     */
    onBatch?: (
      tx: Prisma.TransactionClient,
      batch: { versionIds: string[]; bytesFreed: bigint }
    ) => Promise<void>;
  } = {}
): Promise<PurgeNonCurrentResult> => {
  const batchSize = opts.batchSize ?? 100;
  const maxTotal = opts.maxTotal ?? 10_000;

  const releasedBlobHashes: string[] = [];
  let purgedCount = 0;
  let bytesFreed = 0n;
  let truncated = false;

  while (purgedCount < maxTotal) {
    const remaining = maxTotal - purgedCount;
    const take = Math.min(batchSize, remaining);

    const batch = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          content_blob_hash: string | null;
          is_delete_marker: boolean;
          size_bytes: bigint | null;
        }>
      >`
        SELECT ov."id",
               ov."content_blob_hash",
               ov."is_delete_marker",
               cb."size_bytes"
        FROM "files"."object_versions" ov
        INNER JOIN "files"."objects" o ON o."id" = ov."object_id"
        LEFT JOIN "files"."content_blobs" cb ON cb."hash" = ov."content_blob_hash"
        WHERE o."bucket_id" = ${bucketId}
          AND ov."is_current" = false
          AND ov."deleted_at" IS NULL
        ORDER BY ov."id" ASC
        LIMIT ${take}
        FOR UPDATE OF ov SKIP LOCKED
      `;
      if (rows.length === 0) return null;

      // Bucket before blobs, as an upload takes them.
      await lockForWrite(bucketId, tx);
      const released: string[] = [];
      const purgedIds: string[] = [];
      let batchBytes = 0n;
      for (const row of rows) {
        if (!(await markDeleted(row.id, deletedBy, tx))) continue;
        purgedIds.push(row.id);
        if (row.content_blob_hash && !row.is_delete_marker) {
          released.push(row.content_blob_hash);
          if (row.size_bytes) batchBytes += row.size_bytes;
        }
      }
      await contentBlobs.decRefMany(released, tx);
      // Refund quota in the same transaction as the decRef so a crash can't
      // leave usage permanently inflated. Skip when versioning is disabled —
      // matches `tickPurgeSoftDeleted`'s policy and is a no-op anyway because
      // a non-versioned bucket can't accumulate non-current versions.
      if (versioningEnabled && batchBytes > 0n) {
        await decrementUsage(bucketId, batchBytes, tx);
      }
      if (purgedIds.length > 0) {
        await opts.onBatch?.(tx, {
          versionIds: purgedIds,
          bytesFreed: batchBytes,
        });
      }
      return { count: rows.length, released, bytes: batchBytes };
    });

    if (!batch) break;
    purgedCount += batch.count;
    bytesFreed += batch.bytes;
    releasedBlobHashes.push(...batch.released);
  }

  // Cap reached — probe for any remaining live non-current rows so the caller
  // knows whether to re-invoke. One bounded query, no row scan.
  if (purgedCount >= maxTotal) {
    const more = await prisma.objectVersion.findFirst({
      where: {
        deletedAt: null,
        isCurrent: false,
        object: { bucketId },
      },
      select: { id: true },
    });
    truncated = !!more;
  }

  return { purgedCount, releasedBlobHashes, bytesFreed, truncated };
};

/**
 * Soft-delete a non-current version, release its blob ref and refund the
 * bucket usage it was charged (every retained version counts towards it).
 * Refuses to delete the current version (restore a different version first).
 * Assumes the caller has opened a transaction — most callers should use
 * `softDeleteVersion` instead.
 */
const softDelete = async (
  bucketId: number,
  objectId: string,
  versionId: string,
  deletedBy: string,
  tx: Prisma.TransactionClient
) => {
  // The object's lock, which restore and upload also take first. The row may
  // be soft-deleted: a deleted object's history can still be pruned.
  await tx.$queryRaw`
    SELECT "id" FROM "files"."objects"
    WHERE "id" = ${objectId}::uuid AND "bucket_id" = ${bucketId}
    FOR UPDATE
  `;
  const version = await tx.objectVersion.findFirst({
    where: { objectId, id: versionId, deletedAt: null },
    include: { contentBlob: { select: { sizeBytes: true } } },
  });
  if (!version) throw new NotFoundError("Version not found");
  if (version.isCurrent) {
    throw new BadRequestError(
      "cannot_delete_current_version",
      "Cannot delete the current version. Restore a prior version first."
    );
  }
  // The lifecycle sweep and the history purge don't take the object's lock.
  if (!(await markDeleted(version.id, deletedBy, tx))) {
    throw new NotFoundError("Version not found");
  }
  if (version.contentBlobHash && !version.isDeleteMarker) {
    // Bucket before blob, as an upload takes them.
    await lockForWrite(bucketId, tx);
    await contentBlobs.decRef(version.contentBlobHash, tx);
    const sizeBytes = version.contentBlob?.sizeBytes ?? 0n;
    if (sizeBytes > 0n) await decrementUsage(bucketId, sizeBytes, tx);
  }
  return version;
};
