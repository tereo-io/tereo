import { reserveQuota, decrementUsage, lockForWrite } from "./buckets.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import * as multipartUploads from "./multipartUploads.js";
import * as objectVersions from "./objectVersions.js";
import * as contentBlobs from "./contentBlobs.js";
import { escapeLike } from "./like.js";
import { prisma } from "./prisma.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
} from "../errors.js";

export interface UpsertWithBlobInput {
  bucketId: number;
  objectKey: string;
  /**
   * Overwrite this object, under whatever key it holds once locked, instead of
   * the one at `objectKey` (which is then ignored). `NotFoundError` when it is
   * gone.
   */
  objectId?: string;
  contentType: string;
  contentBlobHash: string;
  sizeBytes: bigint;
  etag: string;
  metadata?: Prisma.InputJsonValue;
  tags?: string[];
  createdBy: string;
  /**
   * Per-object expiry. Omitted, an overwrite keeps the object's current one
   * (set earlier with PATCH); `null` clears it.
   */
  deleteAfter?: Date | null;
  /**
   * The encrypted file this write staged (`SaveBlobResult.stagedPath`).
   * `contentBlobs.attach` places it when this write creates the blob and
   * drops it when the blob already exists. On failure the caller runs
   * `contentBlobs.releaseStaged`.
   */
  stagedPath: string;
  /**
   * `If-Match` / `If-None-Match: *`, checked again under the object's row
   * lock so a write committed after the caller's early check can't slip past
   * them.
   */
  preconditions?: {
    ifMatch: string[] | null;
    ifNoneMatchWildcard: boolean;
  };
  /**
   * When supplied, marks the given multipart upload as completed inside the
   * same transaction that writes the object + version. Ensures completion +
   * object persistence are atomic (callers cannot see an object without its
   * multipart upload record having been finalized).
   */
  markMultipartCompleted?: { uploadId: string };
}

export interface UpsertWithBlobResult {
  type: "created" | "updated";
  object: ObjectWithCurrent;
  /** The bucket's versioning setting the write went by (read under lock). */
  versioningEnabled: boolean;
  /** Blobs the write left unreferenced, for the caller to queue for cleanup. */
  releasedBlobHashes: string[];
}

export interface GetPaginatedOptions {
  bucketId: number;
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Prisma.ObjectWhereInput;
  /**
   * Keyset cursor for sizeBytes-sorted queries (raw SQL path). Pre-decoded —
   * controllers call `decodeListCursor()` before invoking.
   */
  sizeBytesCursor?: { sizeBytes: bigint; id: string; dir: "asc" | "desc" };
}

/**
 * Include clause to fetch the current (non-deleted, non-tombstoned) version of
 * an Object and the joined ContentBlob for size/encryption metadata.
 *
 * Using `take: 1` lets us read the current version even though it's a 1-N
 * relation from Prisma's perspective. Application logic ensures there's at
 * most one row matching these predicates.
 */
const currentVersionInclude = {
  versions: {
    where: { isCurrent: true, deletedAt: null },
    include: { contentBlob: true },
    take: 1,
  },
} satisfies Prisma.ObjectInclude;

export type ObjectWithCurrent = Prisma.ObjectGetPayload<{
  include: typeof currentVersionInclude;
}>;

export const get = async (id: string) => {
  const object = await prisma.object.findUnique({
    where: { id, deletedAt: null },
    include: currentVersionInclude,
  });
  if (!object) throw new NotFoundError("Object not found");
  return object;
};

/**
 * A thumbnail is served only through its parent (`?thumbnail=`), never as an
 * object under its own `.thumbnails/…` key.
 */
export const getByKey = async (bucketId: number, objectKey: string) => {
  const obj = await prisma.object.findFirst({
    where: { bucketId, objectKey, deletedAt: null, thumbnailFor: null },
    include: currentVersionInclude,
  });
  if (!obj) throw new NotFoundError("Object not found");
  return obj;
};

/** Thumbnails are not found: they are served only through their parent. */
export const getById = async (
  bucketId: number,
  id: string,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  const obj = await client.object.findFirst({
    where: { id, bucketId, deletedAt: null, thumbnailFor: null },
    include: currentVersionInclude,
  });
  if (!obj) throw new NotFoundError("Object not found");
  return obj;
};

/**
 * Like `getById` but finds soft-deleted rows too: in a versioned bucket a
 * deleted object's history stays readable by id.
 */
export const getByIdIncludingDeleted = async (bucketId: number, id: string) => {
  const obj = await prisma.object.findFirst({
    where: { id, bucketId, thumbnailFor: null },
    include: currentVersionInclude,
  });
  if (!obj) throw new NotFoundError("Object not found");
  return obj;
};

/**
 * Row-lock the Object (if any) by (bucketId, objectKey) — used as the first
 * step in every write transaction. Returns null if no active Object exists.
 */
const checkByKeyForUpdate = async (
  bucketId: number,
  objectKey: string,
  tx: Prisma.TransactionClient
) => {
  const result = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "files"."objects"
    WHERE "bucket_id" = ${bucketId}
      AND "object_key" = ${objectKey}
      AND "deleted_at" IS NULL
      AND "thumbnail_for" IS NULL
    FOR UPDATE
  `;
  return result.length === 0 ? null : { id: result[0].id };
};

/**
 * Row-lock the Object by (bucketId, id). Used as the first step in every
 * id-addressed mutation transaction (DELETE, PATCH, version ops). Returns the
 * current objectKey so callers can invalidate caches/audit without another
 * lookup. Thumbnails are not found: they change only with their parent.
 */
export const checkByIdForUpdate = async (
  bucketId: number,
  id: string,
  tx: Prisma.TransactionClient
) => {
  const result = await tx.$queryRaw<{ id: string; object_key: string }[]>`
    SELECT "id", "object_key"
    FROM "files"."objects"
    WHERE "bucket_id" = ${bucketId}
      AND "id" = ${id}::uuid
      AND "deleted_at" IS NULL
      AND "thumbnail_for" IS NULL
    FOR UPDATE
  `;
  return result.length === 0
    ? null
    : { id: result[0].id, objectKey: result[0].object_key };
};

/**
 * Scan an `orderBy` array for a `sizeBytes` entry. `sizeBytes` no longer
 * lives on `Object` (it moved to `ContentBlob`, reachable through the
 * current `ObjectVersion`), so Prisma's `object.findMany` cannot sort on
 * it. When a caller asks for it we fall back to a raw SQL join instead.
 *
 * Returns the requested direction, or `null` if no `sizeBytes` entry is
 * present.
 *
 * Simplification: if `sizeBytes` appears alongside other sort fields we
 * honor the `sizeBytes` direction only and drop the secondary fields. In
 * practice the sort pipeline today is single-field plus an `id` tiebreaker
 * (see `createCursorQuerySchema` in `utils/parseQueryString.ts`), so this
 * is a defensive guard rather than a real constraint.
 */
const findSizeBytesSort = (
  orderBy: Record<string, "asc" | "desc">[] | undefined
): "asc" | "desc" | null => {
  if (!orderBy) return null;
  for (const entry of orderBy) {
    if ("sizeBytes" in entry) return entry.sizeBytes;
  }
  return null;
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const {
    bucketId,
    take,
    orderBy,
    where: additionalWhere,
    sizeBytesCursor,
  } = options;

  const where: Prisma.ObjectWhereInput = {
    bucketId,
    deletedAt: null,
    thumbnailFor: null,
    // Objects with no live current version (e.g. delete-marker current) are
    // excluded from standard listings.
    versions: {
      some: { isCurrent: true, deletedAt: null, isDeleteMarker: false },
    },
    ...additionalWhere,
  };

  const sizeBytesDir = findSizeBytesSort(orderBy);

  if (sizeBytesDir !== null) {
    // Sort-by-size path: `sizeBytes` lives on `content_blobs`, so Prisma's
    // orderBy cannot reach it. Raw SQL joins objects → current versions →
    // blobs, orders by (size_bytes, id), and returns the page of ids. We
    // re-hydrate via `findMany` to preserve the regular shape.
    const direction = Prisma.raw(sizeBytesDir === "asc" ? "ASC" : "DESC");
    const op = Prisma.raw(sizeBytesDir === "asc" ? ">" : "<");

    const baseJoin = Prisma.sql`
      FROM "files"."objects" o
      INNER JOIN "files"."object_versions" ov
        ON ov."object_id" = o."id"
        AND ov."is_current" = true
        AND ov."deleted_at" IS NULL
        AND ov."is_delete_marker" = false
      INNER JOIN "files"."content_blobs" cb ON cb."hash" = ov."content_blob_hash"
      WHERE o."bucket_id" = ${bucketId}
        AND o."deleted_at" IS NULL
        AND o."thumbnail_for" IS NULL
    `;

    const cursorClause = sizeBytesCursor
      ? Prisma.sql`AND (cb."size_bytes" ${op} ${sizeBytesCursor.sizeBytes} OR (cb."size_bytes" = ${sizeBytesCursor.sizeBytes} AND o."id" ${op} ${sizeBytesCursor.id}::uuid))`
      : Prisma.empty;

    // Over-fetch by one to detect hasMore without a COUNT(*).
    const idRows = await prisma.$queryRaw<
      { id: string; size_bytes: bigint }[]
    >(Prisma.sql`
      SELECT o."id", cb."size_bytes"
      ${baseJoin}
      ${cursorClause}
      ORDER BY cb."size_bytes" ${direction}, o."id" ${direction}
      LIMIT ${take + 1}
    `);

    const hasMore = idRows.length > take;
    const pageRows = hasMore ? idRows.slice(0, take) : idRows;
    const ids = pageRows.map((r) => r.id);

    let objects: ObjectWithCurrent[] = [];
    if (ids.length > 0) {
      const rows = await prisma.object.findMany({
        where: { id: { in: ids } },
        include: currentVersionInclude,
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      objects = ids
        .map((id) => byId.get(id))
        .filter((o): o is ObjectWithCurrent => o !== undefined);
    }

    return { data: objects, hasMore };
  }

  // Over-fetch by one to detect hasMore without a COUNT(*).
  const rows = await prisma.object.findMany({
    where,
    take: take + 1,
    orderBy: orderBy || { objectKey: "asc" },
    include: currentVersionInclude,
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};

/**
 * Objects deleted in a versioned bucket: soft-deleted rows whose current
 * version is a delete marker, so restoring an earlier version undeletes them.
 * A versioning-off delete keeps no version to restore, so none appear.
 */
export const getDeletedPaginated = async (
  options: Omit<GetPaginatedOptions, "sizeBytesCursor">
) => {
  const { bucketId, take, orderBy, where: additionalWhere } = options;
  const rows = await prisma.object.findMany({
    where: {
      bucketId,
      deletedAt: { not: null },
      thumbnailFor: null,
      versions: {
        some: { isCurrent: true, deletedAt: null, isDeleteMarker: true },
      },
      ...additionalWhere,
    },
    take: take + 1,
    orderBy: orderBy || { objectKey: "asc" },
  });
  const hasMore = rows.length > take;
  return { data: hasMore ? rows.slice(0, take) : rows, hasMore };
};

export const createIdentity = async (
  data: {
    bucketId: number;
    objectKey: string;
    createdBy: string;
    deleteAfter?: Date | null;
    thumbnailFor?: string;
    thumbnailSize?: string;
  },
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.object.create({
    data: {
      bucketId: data.bucketId,
      objectKey: data.objectKey,
      createdBy: data.createdBy,
      deleteAfter: data.deleteAfter ?? null,
      thumbnailFor: data.thumbnailFor ?? null,
      thumbnailSize: data.thumbnailSize ?? null,
    },
  });
};

export const touch = async (id: string, tx?: Prisma.TransactionClient) => {
  const client = tx ?? prisma;
  return await client.object.update({
    where: { id },
    data: { updatedAt: new Date() },
  });
};

/**
 * Set or clear the per-object `deleteAfter` TTL override. `null` clears the
 * override, falling the object back to the bucket-level lifecycle policy.
 */
export const updateDeleteAfter = async (
  id: string,
  deleteAfter: Date | null,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.object.update({
    where: { id },
    data: { deleteAfter, updatedAt: new Date() },
  });
};

export const remove = async (
  id: string,
  deletedBy: string,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.object.update({
    where: { id },
    data: { deletedAt: new Date(), deletedBy },
  });
};

/**
 * Upsert an Object + write a new current ObjectVersion atomically.
 *
 * Invariants maintained:
 *   - Every active ObjectVersion with a blob holds exactly one blob ref.
 *   - An Object has at most one version with isCurrent=true and deletedAt IS NULL.
 *
 * Refcount transitions:
 *   - Versioning OFF: delete previous current version + decRef its blob,
 *     create new current version + incRef new blob.
 *   - Versioning ON: flip previous current isCurrent=false (prior ref kept),
 *     create new current version + incRef new blob.
 *   - Either way, an overwrite hard-deletes the object's thumbnails and
 *     releases their refs.
 *
 * Lock ordering: the key (not taken for a write by `objectId`) → object row →
 * bucket row → content_blobs. The
 * bucket's versioning setting is read under its lock, not taken from the
 * caller. Identical content written concurrently shares one blob (`attach`).
 */
export const upsertWithBlob = async (
  data: UpsertWithBlobInput,
  blobFsPath: string,
  keyMaterial: {
    wrappedDek: Buffer;
    iv: Buffer;
    masterKeyVersion: number;
  },
  outerTx?: Prisma.TransactionClient
): Promise<UpsertWithBlobResult> => {
  const run = async (
    tx: Prisma.TransactionClient
  ): Promise<UpsertWithBlobResult> => {
    let objectKey = data.objectKey;
    let existingRow: { id: string } | null;
    if (data.objectId) {
      const row = await checkByIdForUpdate(data.bucketId, data.objectId, tx);
      if (!row) throw new NotFoundError("Object not found");
      existingRow = { id: row.id };
      objectKey = row.objectKey;
    } else {
      // A key with no object yet has no row to lock: writers to it queue here,
      // so the second finds the first's object and overwrites it instead of
      // colliding on the unique key.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`files:key:${data.bucketId}:${data.objectKey}`}, 0))`;
      existingRow = await checkByKeyForUpdate(
        data.bucketId,
        data.objectKey,
        tx
      );
    }

    // Serialize concurrent uploads to the same bucket and close the race
    // with soft-delete. `reserveQuota` below takes an implicit NO KEY UPDATE
    // lock on this row; acquiring it here up front avoids the SHARE→UPDATE
    // lock-upgrade deadlock two parallel uploads would hit otherwise, and it
    // blocks concurrent `deleteBucket` (which also flips a non-key column)
    // so if the delete has committed we refuse the upload cleanly.
    const bucketRow = await lockForWrite(data.bucketId, tx);
    if (!bucketRow || bucketRow.deleted) {
      throw new ConflictError("bucket deleted");
    }
    const { versioningEnabled } = bucketRow;
    const releasedBlobHashes: string[] = [];

    if (data.preconditions?.ifNoneMatchWildcard && existingRow) {
      throw new PreconditionFailedError(
        "Object already exists (If-None-Match: *)"
      );
    }
    const ifMatch = data.preconditions?.ifMatch;
    if (ifMatch) {
      const current = existingRow
        ? await tx.objectVersion.findFirst({
            where: {
              objectId: existingRow.id,
              isCurrent: true,
              deletedAt: null,
            },
            select: { etag: true },
          })
        : null;
      if (
        !current?.etag ||
        !(ifMatch.includes("*") || ifMatch.includes(current.etag))
      ) {
        throw new PreconditionFailedError("ETag mismatch (If-Match)");
      }
    }

    const priorCurrent = existingRow
      ? await tx.objectVersion.findFirst({
          where: {
            objectId: existingRow.id,
            isCurrent: true,
            deletedAt: null,
          },
        })
      : null;
    // The blobs this write releases, locked around the attach in hash order.
    const released = existingRow
      ? await releasableBlobHashes([existingRow.id], false, tx)
      : [];
    if (!versioningEnabled && priorCurrent?.contentBlobHash) {
      released.push(priorCurrent.contentBlobHash);
    }
    await contentBlobs.lockInOrder(
      released.filter((hash) => hash < data.contentBlobHash),
      tx
    );
    await contentBlobs.attach(
      {
        hash: data.contentBlobHash,
        sizeBytes: data.sizeBytes,
        fsPath: blobFsPath,
        wrappedDek: keyMaterial.wrappedDek,
        iv: keyMaterial.iv,
        masterKeyVersion: keyMaterial.masterKeyVersion,
        stagedPath: data.stagedPath,
      },
      tx
    );
    await contentBlobs.lockInOrder(
      released.filter((hash) => hash > data.contentBlobHash),
      tx
    );

    if (existingRow) {
      const priorSize =
        priorCurrent?.contentBlobHash != null
          ? ((
              await tx.contentBlob.findUnique({
                where: { hash: priorCurrent.contentBlobHash },
                select: { sizeBytes: true },
              })
            )?.sizeBytes ?? 0n)
          : 0n;

      // Quota accounting depends on versioning:
      //  - Versioning OFF: prior blob is released (overwrite mode), so the
      //    net delta is new - prior.
      //  - Versioning ON: prior blob is retained on disk (it now backs a
      //    historical version), so the bucket grows by the full new size.
      if (versioningEnabled) {
        await reserveQuota(data.bucketId, data.sizeBytes, tx);
      } else {
        const sizeDelta = data.sizeBytes - priorSize;
        if (sizeDelta > 0n) {
          await reserveQuota(data.bucketId, sizeDelta, tx);
        } else if (sizeDelta < 0n) {
          await decrementUsage(data.bucketId, -sizeDelta, tx);
        }
      }

      if (versioningEnabled) {
        // Retain prior version; flip its current flag and keep its blob ref.
        if (priorCurrent) {
          await tx.objectVersion.update({
            where: { id: priorCurrent.id },
            data: { isCurrent: false, noncurrentSince: new Date() },
          });
        }
      } else {
        // Overwrite mode: drop the prior version and release its ref.
        if (priorCurrent) {
          if (
            priorCurrent.contentBlobHash &&
            (await contentBlobs.decRef(priorCurrent.contentBlobHash, tx)) === 0
          ) {
            releasedBlobHashes.push(priorCurrent.contentBlobHash);
          }
          await tx.objectVersion.delete({ where: { id: priorCurrent.id } });
        }
      }

      await contentBlobs.incRef(data.contentBlobHash, tx);
      await objectVersions.create(
        {
          objectId: existingRow.id,
          contentBlobHash: data.contentBlobHash,
          etag: data.etag,
          contentType: data.contentType,
          metadata: data.metadata,
          tags: data.tags,
          createdBy: data.createdBy,
          isCurrent: true,
        },
        tx
      );

      // The old content's thumbnails go with it; the caller queues new ones
      // when the new content is an image.
      releasedBlobHashes.push(...(await dropThumbnails([existingRow.id], tx)));

      await tx.object.update({
        where: { id: existingRow.id },
        data: {
          updatedAt: new Date(),
          ...(data.deleteAfter !== undefined
            ? { deleteAfter: data.deleteAfter }
            : {}),
        },
      });

      if (data.markMultipartCompleted) {
        await multipartUploads.markCompleted(
          data.markMultipartCompleted.uploadId,
          tx
        );
      }

      const hydrated = await tx.object.findUnique({
        where: { id: existingRow.id },
        include: currentVersionInclude,
      });
      if (!hydrated) throw new NotFoundError("Object not found after upsert");
      return {
        type: "updated" as const,
        object: hydrated,
        versioningEnabled,
        releasedBlobHashes,
      };
    }

    await reserveQuota(data.bucketId, data.sizeBytes, tx);

    const created = await createIdentity(
      {
        bucketId: data.bucketId,
        objectKey: objectKey,
        createdBy: data.createdBy,
        deleteAfter: data.deleteAfter,
      },
      tx
    );

    await contentBlobs.incRef(data.contentBlobHash, tx);
    await objectVersions.create(
      {
        objectId: created.id,
        contentBlobHash: data.contentBlobHash,
        etag: data.etag,
        contentType: data.contentType,
        metadata: data.metadata,
        tags: data.tags,
        createdBy: data.createdBy,
        isCurrent: true,
      },
      tx
    );

    if (data.markMultipartCompleted) {
      await multipartUploads.markCompleted(
        data.markMultipartCompleted.uploadId,
        tx
      );
    }

    const hydrated = await tx.object.findUnique({
      where: { id: created.id },
      include: currentVersionInclude,
    });
    if (!hydrated) throw new NotFoundError("Object not found after upsert");
    return {
      type: "created" as const,
      object: hydrated,
      versioningEnabled,
      releasedBlobHashes: [],
    };
  };
  try {
    return outerTx ? await run(outerTx) : await prisma.$transaction(run);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      if (data.preconditions?.ifNoneMatchWildcard) {
        throw new PreconditionFailedError(
          "Object already exists (If-None-Match: *)"
        );
      }
      throw new ConflictError("Object was concurrently created");
    }
    throw err;
  }
};

/**
 * Inner removal logic shared by `removeExpiredObject` (lifecycle) and
 * `removeObjectById` (id-based). Assumes the caller has already row-locked the
 * Object and passed its id + bucketId through. Runs inside the caller's
 * transaction.
 *
 *   - Versioning OFF: delete the (single) current version row, decRef its blob
 *     and refund its size. Returns the released blob hash so the caller can
 *     enqueue orphan cleanup.
 *   - Versioning ON: flip the current version to isCurrent=false, insert a
 *     delete-marker version as the new current. No blob refs are touched.
 *
 * In both cases the Object row itself is soft-deleted (deletedAt set). The
 * versioning setting is the bucket's, read under its lock, and returned;
 * `ConflictError` once the bucket is deleted, whose cleanup owns the refs.
 */
const removeLockedObject = async (
  bucketId: number,
  objectId: string,
  deletedBy: string,
  tx: Prisma.TransactionClient
): Promise<{
  id: string;
  releasedBlobHashes: string[];
  versioningEnabled: boolean;
}> => {
  const bucketRow = await lockForWrite(bucketId, tx);
  if (!bucketRow || bucketRow.deleted) {
    throw new ConflictError("bucket deleted");
  }
  const { versioningEnabled } = bucketRow;
  const current = await tx.objectVersion.findFirst({
    where: { objectId, isCurrent: true, deletedAt: null },
  });
  await contentBlobs.lockInOrder(
    await releasableBlobHashes([objectId], !versioningEnabled, tx),
    tx
  );

  const releasedBlobHashes: string[] = [];

  if (versioningEnabled) {
    if (current) {
      await tx.objectVersion.update({
        where: { id: current.id },
        data: { isCurrent: false, noncurrentSince: new Date() },
      });
    }
    await objectVersions.create(
      {
        objectId,
        contentBlobHash: null,
        etag: null,
        contentType: null,
        createdBy: deletedBy,
        isCurrent: true,
        isDeleteMarker: true,
      },
      tx
    );
  } else if (current) {
    // Read without a lock: a version another transaction has released since
    // is no longer deleted here, so its ref and usage are not released twice.
    const { count } = await tx.objectVersion.deleteMany({
      where: { id: current.id, deletedAt: null },
    });
    if (count > 0 && current.contentBlobHash) {
      const blob = await tx.contentBlob.findUnique({
        where: { hash: current.contentBlobHash },
        select: { sizeBytes: true },
      });
      if (blob && blob.sizeBytes > 0n) {
        await decrementUsage(bucketId, blob.sizeBytes, tx);
      }
      await contentBlobs.decRef(current.contentBlobHash, tx);
      releasedBlobHashes.push(current.contentBlobHash);
    }
  }

  await remove(objectId, deletedBy, tx);
  releasedBlobHashes.push(...(await dropThumbnails([objectId], tx)));

  return { id: objectId, releasedBlobHashes, versioningEnabled };
};

/**
 * The blobs a release from these objects can touch: those held by their
 * thumbnails' live versions and, with `ownVersions`, by their own. Read under
 * the objects' locks, which keep thumbnails from being written meanwhile, so
 * the caller can lock them up front with `contentBlobs.lockInOrder`.
 */
const releasableBlobHashes = async (
  objectIds: string[],
  ownVersions: boolean,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const own = ownVersions
    ? Prisma.sql`OR o."id" = ANY(${objectIds}::uuid[])`
    : Prisma.empty;
  const rows = await tx.$queryRaw<{ hash: string }[]>`
    SELECT DISTINCT ov."content_blob_hash" AS hash
    FROM "files"."object_versions" ov
    INNER JOIN "files"."objects" o ON o."id" = ov."object_id"
    WHERE (o."thumbnail_for" = ANY(${objectIds}::uuid[]) ${own})
      AND ov."deleted_at" IS NULL
      AND ov."is_delete_marker" = false
      AND ov."content_blob_hash" IS NOT NULL
  `;
  return rows.map((r) => r.hash);
};

/**
 * Before a batch of `removeLockedObject` calls on locked objects: lock the
 * bucket and then every blob the batch can release, so they are taken in one
 * order rather than object by object.
 */
const lockForRemoval = async (
  bucketId: number,
  objectIds: string[],
  tx: Prisma.TransactionClient
): Promise<void> => {
  if (objectIds.length === 0) return;
  const bucketRow = await lockForWrite(bucketId, tx);
  if (!bucketRow || bucketRow.deleted) return;
  await contentBlobs.lockInOrder(
    await releasableBlobHashes(objectIds, !bucketRow.versioningEnabled, tx),
    tx
  );
};

/**
 * Hard-delete the thumbnails of objects being deleted or purged, releasing
 * the blob refs their live versions hold. A thumbnail is derived from its
 * parent's current content and lives only while the parent does — even in a
 * versioned bucket, where the parent's history is kept; a restore queues
 * fresh ones. Thumbnails are never charged to the bucket's usage, so nothing
 * is refunded. Returns the hashes whose refCount reached zero.
 */
const dropThumbnails = async (
  parentIds: string[],
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "files"."objects"
    WHERE "thumbnail_for" = ANY(${parentIds}::uuid[])
    ORDER BY "id" ASC
    FOR UPDATE
  `;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const { freedHashes } = await contentBlobs.decRefForObjectVersions(ids, tx);
  await deleteManyByIds(ids, tx);
  return freedHashes;
};

/**
 * Soft-delete an Object by its UUID id. The id-addressed DELETE route calls
 * this; semantics are identical to `removeExpiredObject` (lifecycle sweeps).
 * Accepts an optional outer `tx` for outbox-publish atomicity.
 */
export const removeObjectById = async (
  bucketId: number,
  id: string,
  deletedBy: string,
  tx?: Prisma.TransactionClient
): Promise<{
  id: string;
  objectKey: string;
  releasedBlobHashes: string[];
  versioningEnabled: boolean;
}> => {
  const run = async (t: Prisma.TransactionClient) => {
    const existing = await checkByIdForUpdate(bucketId, id, t);
    if (!existing) throw new NotFoundError("Object not found");
    const result = await removeLockedObject(
      bucketId,
      existing.id,
      deletedBy,
      t
    );
    return { ...result, objectKey: existing.objectKey };
  };
  return tx ? run(tx) : prisma.$transaction(run);
};

/**
 * What makes an object expired: its current version (its last write) older
 * than `lastWrittenBefore` — the bucket policy's `expireObjectsAfterDays` —
 * or its own `deleteAfter` passed.
 */
export type ExpiryRule =
  { lastWrittenBefore: Date } | { deleteAfterBefore: Date };

export interface RemovedObject {
  id: string;
  objectKey: string;
  releasedBlobHashes: string[];
}

/**
 * Soft-delete the objects a lifecycle sweep found expired, in one
 * transaction. The sweep reads its batch before deleting, so each object is
 * re-checked under its lock: one deleted, renamed, written again or given a
 * later expiry since then is left alone, and nothing that took over its key
 * is touched. Rows another writer holds are skipped (a later sweep gets
 * them): every row is locked before the bucket is, as an upload locks them.
 *
 * `onRemoved` runs in the same transaction with what was removed, so the
 * audit entry for the batch commits or rolls back with it.
 */
export const removeExpiredObjects = async (
  bucketId: number,
  ids: string[],
  rule: ExpiryRule,
  deletedBy: string,
  onRemoved?: (
    tx: Prisma.TransactionClient,
    removed: RemovedObject[]
  ) => Promise<void>
): Promise<RemovedObject[]> => {
  if (ids.length === 0) return [];
  const expired =
    "lastWrittenBefore" in rule
      ? Prisma.sql`EXISTS (
          SELECT 1 FROM "files"."object_versions" ov
          WHERE ov."object_id" = o."id"
            AND ov."is_current" = true
            AND ov."deleted_at" IS NULL
            AND ov."created_at" < ${rule.lastWrittenBefore}
        )`
      : Prisma.sql`o."delete_after" < ${rule.deleteAfterBefore}`;
  return await prisma.$transaction(async (tx) => {
    // NO KEY UPDATE, not UPDATE: a plain FOR UPDATE would also skip rows held
    // only by a foreign-key check, like the access log written after an upload.
    const rows = await tx.$queryRaw<{ id: string; object_key: string }[]>`
      SELECT o."id", o."object_key"
      FROM "files"."objects" o
      WHERE o."bucket_id" = ${bucketId}
        AND o."id" = ANY(${ids}::uuid[])
        AND o."deleted_at" IS NULL
        AND o."thumbnail_for" IS NULL
        AND ${expired}
      ORDER BY o."id" ASC
      FOR NO KEY UPDATE OF o SKIP LOCKED
    `;
    await lockForRemoval(
      bucketId,
      rows.map((r) => r.id),
      tx
    );
    const removed: RemovedObject[] = [];
    for (const row of rows) {
      const result = await removeLockedObject(bucketId, row.id, deletedBy, tx);
      removed.push({
        id: row.id,
        objectKey: row.object_key,
        releasedBlobHashes: result.releasedBlobHashes,
      });
    }
    if (removed.length > 0) await onRemoved?.(tx, removed);
    return removed;
  });
};

/**
 * Restore a prior (non-current) version as the current version. Creates a
 * new ObjectVersion pointing at the same blob; the previous current stays
 * in history. Holds Object + blob locks for the duration so concurrent
 * restores cannot leave the object with two `isCurrent=true` rows and a
 * racing orphan-cleanup worker cannot sweep the blob mid-restore.
 *
 * Lock ordering: object row → bucket row → content_blobs, as upload and
 * delete take them. Versioning is read under the bucket lock:
 * `BadRequestError("versioning_disabled")` when it has been turned off.
 *
 * A soft-deleted object (versioned DELETE: delete marker as current) is
 * undeleted: the restored version replaces the marker and the Object row is
 * live again, unless another live object has since taken its key. A
 * `deleteAfter` already in the past is cleared so the TTL sweep does not
 * delete the object again straight away.
 *
 * Throws `BadRequestError` when the source version is already current, is
 * a delete-marker, or its blob has already been swept past the grace
 * window. Throws `NotFoundError` when the object or source version are
 * gone, and `ConflictError` when undeleting onto a key that is taken.
 */
export const restoreObjectVersion = async (
  bucketId: number,
  id: string,
  versionId: string,
  createdBy: string,
  orphanBlobGraceSeconds: number,
  outerTx?: Prisma.TransactionClient
): Promise<{
  restored: Awaited<ReturnType<typeof objectVersions.create>>;
  source: Awaited<ReturnType<typeof objectVersions.getByVersionId>>;
  object: { id: string; objectKey: string };
  undeleted: boolean;
  /** Blobs of the thumbnails the restore dropped that nothing else holds. */
  releasedBlobHashes: string[];
}> => {
  const run = async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        object_key: string;
        deleted_at: Date | null;
        delete_after: Date | null;
      }[]
    >`
      SELECT "id", "object_key", "deleted_at", "delete_after"
      FROM "files"."objects"
      WHERE "bucket_id" = ${bucketId}
        AND "id" = ${id}::uuid
        AND "thumbnail_for" IS NULL
      FOR UPDATE
    `;
    if (rows.length === 0) throw new NotFoundError("Object not found");
    const existing = { id: rows[0].id, objectKey: rows[0].object_key };
    const undeleted = rows[0].deleted_at !== null;
    if (
      undeleted &&
      (await checkByKeyForUpdate(bucketId, existing.objectKey, tx))
    ) {
      throw new ConflictError(
        "Another object now has this key; delete or rename it before restoring"
      );
    }

    // Bucket before blob, the order uploads and deletes take them in. The
    // versioning setting is the one under this lock, not the request's.
    const bucketRow = await lockForWrite(bucketId, tx);
    if (!bucketRow || bucketRow.deleted) {
      throw new ConflictError("bucket deleted");
    }
    if (!bucketRow.versioningEnabled) {
      throw new BadRequestError(
        "versioning_disabled",
        "Versioning is not enabled for this bucket"
      );
    }

    const source = await objectVersions.getByVersionId(
      existing.id,
      versionId,
      tx
    );
    if (source.isCurrent) {
      throw new BadRequestError(
        "already_current",
        "Specified version is already the current version"
      );
    }
    if (source.isDeleteMarker || !source.contentBlobHash) {
      throw new BadRequestError(
        "cannot_restore_delete_marker",
        "Cannot restore a delete marker. Upload new content instead."
      );
    }

    await contentBlobs.lockInOrder(
      [
        source.contentBlobHash,
        ...(await releasableBlobHashes([existing.id], false, tx)),
      ],
      tx
    );
    const blob = await contentBlobs.lockByHashForUpdate(
      source.contentBlobHash,
      tx
    );
    if (!blob) {
      throw new BadRequestError(
        "blob_swept",
        "Source version's content has already been swept and cannot be restored"
      );
    }
    if (
      blob.refCount === 0 &&
      blob.orphanedAt !== null &&
      Date.now() - blob.orphanedAt.getTime() >= orphanBlobGraceSeconds * 1000
    ) {
      throw new BadRequestError(
        "blob_swept",
        "Source version's content is past the orphan grace period and cannot be restored"
      );
    }

    // Restore adds a new live ObjectVersion holding a fresh blob ref — bucket
    // usage must grow by the blob's size. (`unmarkAllCurrent` only flips the
    // prior current to non-current; its blob ref is preserved for history, so
    // the delta is purely additive.) Throws InsufficientStorageError if the
    // restore would push the bucket over its quota.
    const blobSizeBytes = await contentBlobs
      .requireByHash(source.contentBlobHash, tx)
      .then((b) => b.sizeBytes);
    await reserveQuota(bucketId, blobSizeBytes, tx);

    await objectVersions.unmarkAllCurrent(existing.id, tx);
    await contentBlobs.incRef(source.contentBlobHash, tx);
    const restored = await objectVersions.create(
      {
        objectId: existing.id,
        contentBlobHash: source.contentBlobHash,
        etag: source.etag,
        contentType: source.contentType,
        metadata: (source.metadata as never) ?? undefined,
        tags: source.tags,
        createdBy,
        isCurrent: true,
        restoredFromVersionId: source.id,
      },
      tx
    );
    const releasedBlobHashes = await dropThumbnails([existing.id], tx);
    if (undeleted) {
      const deleteAfter = rows[0].delete_after;
      await tx.object.update({
        where: { id: existing.id },
        data: {
          deletedAt: null,
          deletedBy: null,
          ...(deleteAfter && deleteAfter.getTime() <= Date.now()
            ? { deleteAfter: null }
            : {}),
        },
      });
    }
    return {
      restored,
      source,
      object: existing,
      undeleted,
      releasedBlobHashes,
    };
  };
  try {
    return outerTx ? await run(outerTx) : await prisma.$transaction(run);
  } catch (err) {
    // A live object created under the same key after the check above.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ConflictError(
        "Another object now has this key; delete or rename it before restoring"
      );
    }
    throw err;
  }
};

/**
 * Create a new current ObjectVersion that inherits the existing current
 * version's content blob while overriding the supplied metadata fields.
 * Serializes with concurrent writes via the id-row lock. This is the
 * versioning-enabled PATCH path — keeps the "every mutation creates a
 * version" invariant for metadata edits without duplicating bytes on disk.
 *
 * The inner helper (`objectVersions.branchCurrentWithMetadata`) requires
 * the Object row to already be locked; this wrapper is the public API that
 * callers should use, keeping the transaction scope in the db layer.
 *
 * Returns false, writing nothing, when the bucket's versioning (read under
 * its lock) is off: the caller then edits the current version in place.
 */
export const branchCurrentVersion = async (
  bucketId: number,
  id: string,
  patch: {
    contentType?: string;
    metadata?: Prisma.InputJsonValue;
    tags?: string[];
    createdBy: string;
  },
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const run = async (t: Prisma.TransactionClient) => {
    const existing = await checkByIdForUpdate(bucketId, id, t);
    if (!existing) throw new NotFoundError("Object not found");
    // Object → bucket → blob, as uploads lock them; the versioning setting is
    // the one under the bucket's lock.
    const bucketRow = await lockForWrite(bucketId, t);
    if (!bucketRow || bucketRow.deleted) {
      throw new ConflictError("bucket deleted");
    }
    if (!bucketRow.versioningEnabled) return false;
    await objectVersions.branchCurrentWithMetadata(
      bucketId,
      existing.id,
      patch,
      t
    );
    return true;
  };
  return tx ? await run(tx) : await prisma.$transaction(run);
};

/**
 * Rename an Object (change its `objectKey`). The partial unique index
 * `objects_bucket_live_key` (bucket_id, object_key) WHERE deleted_at IS NULL
 * protects against collisions — a P2002 unique violation surfaces as a
 * `ConflictError` so the route can return 409. The object's `id` does not
 * change, so any references held by callers remain valid.
 */
export const renameObject = async (
  bucketId: number,
  id: string,
  newObjectKey: string,
  updatedBy: string,
  tx?: Prisma.TransactionClient
): Promise<{ id: string; previousKey: string; newKey: string }> => {
  const run = async (
    t: Prisma.TransactionClient
  ): Promise<{ id: string; previousKey: string; newKey: string }> => {
    const existing = await checkByIdForUpdate(bucketId, id, t);
    if (!existing) throw new NotFoundError("Object not found");
    if (existing.objectKey === newObjectKey) {
      return {
        id: existing.id,
        previousKey: existing.objectKey,
        newKey: existing.objectKey,
      };
    }
    await t.object.update({
      where: { id: existing.id },
      data: { objectKey: newObjectKey, updatedAt: new Date() },
    });
    // updatedBy is captured in the audit log / webhook layer by the caller;
    // the Object schema doesn't have an `updatedBy` column today. Keep the
    // parameter in the signature so future schema changes are ergonomic.
    void updatedBy;
    return {
      id: existing.id,
      previousKey: existing.objectKey,
      newKey: newObjectKey,
    };
  };
  try {
    return tx ? await run(tx) : await prisma.$transaction(run);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ConflictError(
        "An object with that key already exists in this bucket"
      );
    }
    throw err;
  }
};

/**
 * List virtual folders (common prefixes) + leaf objects under a prefix.
 * Powers the UI tree view.
 *
 * Total size is summed from ContentBlob via the current, non-deleted,
 * non-delete-marker version of each object under the prefix.
 *
 * Pagination is cursor-based and independent across the two result sets:
 * `folderCursor` advances through folder segments ordered by `segment` ASC,
 * `objectCursor` advances through leaf objects ordered by `object_key` ASC.
 * Each cursor is simply the last returned string value — tamper-proof decoding
 * is handled by the caller; `listPrefixes` itself just does a `> cursor` WHERE
 * clause. We over-fetch by one to compute `hasMore` without a count. A set
 * marked done in `exhausted` was fully listed on an earlier page and is not
 * queried again.
 */
export const listPrefixes = async (
  bucketId: number,
  prefix: string,
  delimiter: string,
  limit: number,
  folderCursor?: string,
  objectCursor?: string,
  exhausted: { folders?: boolean; objects?: boolean } = {}
) => {
  // NOTE: `GROUP BY` / `ORDER BY` on a parameterized expression (e.g.
  // `${prefix} || segment`) trips Postgres's group-by inference — the planner
  // does not consider two parameter references as the same expression, so it
  // errors with `column "segment" must appear in the GROUP BY clause`. Group
  // purely by `segment` and prepend the prefix in the outer SELECT instead.
  const folderCursorClause = folderCursor
    ? Prisma.sql`HAVING segment > ${folderCursor}`
    : Prisma.empty;
  const folderRows = exhausted.folders
    ? []
    : await prisma.$queryRaw<
        {
          prefix: string;
          segment: string;
          object_count: bigint;
          total_size_bytes: bigint;
        }[]
      >(Prisma.sql`
    WITH current_blobs AS (
      SELECT
        o.object_key,
        cb.size_bytes
      FROM "files"."objects" o
      INNER JOIN "files"."object_versions" ov
        ON ov.object_id = o.id
        AND ov.is_current = true
        AND ov.deleted_at IS NULL
        AND ov.is_delete_marker = false
      INNER JOIN "files"."content_blobs" cb ON cb.hash = ov.content_blob_hash
      WHERE o.bucket_id = ${bucketId}
        AND o.deleted_at IS NULL
        AND o.thumbnail_for IS NULL
        AND o.object_key LIKE (${escapeLike(prefix)} || '%')
    ),
    tails AS (
      SELECT
        substring(
          object_key FROM (char_length(${prefix}) + 1)
          FOR (
            COALESCE(
              NULLIF(position(${delimiter} IN substring(object_key FROM (char_length(${prefix}) + 1))), 0)
                + char_length(${delimiter}) - 1,
              0
            )
          )
        ) AS segment,
        size_bytes
      FROM current_blobs
    ),
    folders AS (
      SELECT
        segment,
        count(*)::bigint AS "object_count",
        COALESCE(sum(size_bytes), 0)::bigint AS "total_size_bytes"
      FROM tails
      WHERE segment <> ''
      GROUP BY segment
      ${folderCursorClause}
      ORDER BY segment ASC
      LIMIT ${limit + 1}
    )
    SELECT
      (${prefix} || segment) AS "prefix",
      segment,
      "object_count",
      "total_size_bytes"
    FROM folders
  `);

  const foldersHasMore = folderRows.length > limit;
  const foldersPage = foldersHasMore ? folderRows.slice(0, limit) : folderRows;

  // Leaf objects: those whose KEY TAIL (after stripping the prefix) contains
  // no delimiter. The previous Prisma-level `not: { contains: delimiter }`
  // check was wrong because it ran against the full key — for prefix=`foo/`
  // and key `foo/bar.txt`, the full key contains `/` and so `bar.txt` was
  // always excluded.
  const objectCursorClause = objectCursor
    ? Prisma.sql`AND o."object_key" > ${objectCursor}`
    : Prisma.empty;
  const leafIdRows = exhausted.objects
    ? []
    : await prisma.$queryRaw<{ id: string; object_key: string }[]>(Prisma.sql`
    SELECT o."id", o."object_key"
    FROM "files"."objects" o
    WHERE o."bucket_id" = ${bucketId}
      AND o."deleted_at" IS NULL
      AND o."thumbnail_for" IS NULL
      AND o."object_key" LIKE (${escapeLike(prefix)} || '%')
      AND position(${delimiter} IN substring(o."object_key" FROM (char_length(${prefix}) + 1))) = 0
      ${objectCursorClause}
      AND EXISTS (
        SELECT 1 FROM "files"."object_versions" ov
        WHERE ov."object_id" = o."id"
          AND ov."is_current" = true
          AND ov."deleted_at" IS NULL
          AND ov."is_delete_marker" = false
      )
    ORDER BY o."object_key" ASC
    LIMIT ${limit + 1}
  `);

  const objectsHasMore = leafIdRows.length > limit;
  const leafIdsPage = objectsHasMore ? leafIdRows.slice(0, limit) : leafIdRows;

  const objects =
    leafIdsPage.length === 0
      ? []
      : await prisma.object.findMany({
          where: { id: { in: leafIdsPage.map((r) => r.id) } },
          orderBy: { objectKey: "asc" },
          include: currentVersionInclude,
        });

  const serializedPrefixes = foldersPage.map((r) => ({
    prefix: r.prefix,
    segment: r.segment,
    objectCount: Number(r.object_count),
    totalSizeBytes: r.total_size_bytes.toString(),
  }));
  const serializedObjects = objects.flatMap((o) => {
    const current = o.versions[0];
    if (!current || !current.contentBlob) return [];
    return [
      {
        id: o.id,
        key: o.objectKey,
        contentType: current.contentType ?? "application/octet-stream",
        sizeBytes: current.contentBlob.sizeBytes.toString(),
        etag: current.etag ?? "",
        tags: current.tags,
        updatedAt: o.updatedAt,
      },
    ];
  });

  const lastFolder = serializedPrefixes[serializedPrefixes.length - 1];
  const lastObject = serializedObjects[serializedObjects.length - 1];

  return {
    prefixes: serializedPrefixes.map(({ segment: _segment, ...rest }) => rest),
    objects: serializedObjects,
    foldersHasMore,
    objectsHasMore,
    lastFolderSegment: foldersHasMore && lastFolder ? lastFolder.segment : null,
    lastObjectKey: objectsHasMore && lastObject ? lastObject.key : null,
  };
};

export const getThumbnail = async (parentId: string, size: string) => {
  return await prisma.object.findFirst({
    where: { thumbnailFor: parentId, thumbnailSize: size, deletedAt: null },
    include: currentVersionInclude,
  });
};

/**
 * Find the existing thumbnail Object (if any) for a given parent + size,
 * joining its current non-deleted version. Used by the thumbnail pipeline to
 * decide between replacing an existing thumb vs. creating a new one.
 */
export const findThumbnailByParent = async (
  bucketId: number,
  parentObjectId: string,
  thumbnailSize: string,
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  return await client.object.findFirst({
    where: {
      bucketId,
      thumbnailFor: parentObjectId,
      thumbnailSize,
      deletedAt: null,
    },
    include: {
      versions: { where: { isCurrent: true, deletedAt: null }, take: 1 },
    },
  });
};

/**
 * Batch hard-delete Object rows by id (cascades to their ObjectVersion rows).
 * Used by the lifecycle sweep after it has already accounted for any surviving
 * blob references. Callers must drop the blob refs themselves in the same tx.
 */
export const deleteManyByIds = async (
  ids: string[],
  tx?: Prisma.TransactionClient
) => {
  const client = tx ?? prisma;
  await client.object.deleteMany({ where: { id: { in: ids } } });
};

/**
 * Hard-delete soft-deleted objects (their versions cascade), releasing the
 * blob refs their live versions hold and, with `refundUsage`, the usage those
 * versions were charged. The sweep reads its batch before purging, so each
 * object is re-checked under its lock: one undeleted since then is kept.
 * `onPurged` runs in the same transaction with the purged ids.
 */
export const purgeSoftDeletedObjects = async (
  bucketId: number,
  ids: string[],
  deletedBefore: Date,
  refundUsage: boolean,
  onPurged?: (
    tx: Prisma.TransactionClient,
    purgedIds: string[]
  ) => Promise<void>
): Promise<{ purgedIds: string[]; freedHashes: string[] }> => {
  if (ids.length === 0) return { purgedIds: [], freedHashes: [] };
  return await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "files"."objects"
      WHERE "bucket_id" = ${bucketId}
        AND "id" = ANY(${ids}::uuid[])
        AND "deleted_at" < ${deletedBefore}
      ORDER BY "id" ASC
      FOR UPDATE
    `;
    const purgedIds = rows.map((r) => r.id);
    if (purgedIds.length === 0) return { purgedIds, freedHashes: [] };
    // Object rows → bucket → blobs, as an upload takes them.
    await lockForWrite(bucketId, tx);
    await contentBlobs.lockInOrder(
      await releasableBlobHashes(purgedIds, true, tx),
      tx
    );
    const { freedHashes, releasedBytes: bytes } =
      await contentBlobs.decRefForObjectVersions(purgedIds, tx);
    // Their rows would cascade with the parents', leaving the refs held.
    freedHashes.push(...(await dropThumbnails(purgedIds, tx)));
    if (refundUsage && bytes > 0n) {
      await decrementUsage(bucketId, bytes, tx);
    }
    await deleteManyByIds(purgedIds, tx);
    await onPurged?.(tx, purgedIds);
    return { purgedIds, freedHashes };
  });
};

export type BulkDeleteFilter =
  { kind: "prefix"; prefix: string } | { kind: "ids"; ids: string[] };

export interface BulkDeleteResult {
  deletedObjects: Array<{ id: string; objectKey: string }>;
  releasedBlobHashes: string[];
  /**
   * True when a prefix filter matched more objects than `maxTotal` and the
   * request stopped early. Caller should surface this so the user knows to
   * resubmit. Always false for id-filter calls (the id list bounds the work).
   */
  truncated: boolean;
}

/**
 * Bulk soft-delete Object rows matched by either a key prefix or an explicit
 * id list. Applies the same per-object semantics as `removeLockedObject`
 * (versioned bucket → delete-marker version; non-versioned → drop version +
 * decRef blob), just batched under a single caller-initiated transaction per
 * chunk.
 *
 * Runs in chunks of `batchSize` rows each under its own short transaction —
 * bounds the number of locks we hold at once and lets concurrent uploads or
 * single-object deletes make progress (`FOR NO KEY UPDATE SKIP LOCKED`). Loops until
 * the filter is exhausted or `maxTotal` is reached.
 *
 * For id filters, `seenIds` tracks every id the caller requested so we don't
 * re-poll rows that were skipped by SKIP LOCKED or already soft-deleted
 * between batches — otherwise the loop could spin forever on transient
 * contention.
 */
export const removeObjectsBulk = async (
  bucketId: number,
  filter: BulkDeleteFilter,
  deletedBy: string,
  opts: {
    batchSize?: number;
    maxTotal?: number;
    /**
     * Runs in each batch's transaction, after its deletes, so the batch's
     * audit entry commits with them. `versioningEnabled` is the bucket's
     * setting the batch went by, read under its lock.
     */
    onBatch?: (
      tx: Prisma.TransactionClient,
      batch: {
        deleted: Array<{ id: string; objectKey: string }>;
        versioningEnabled: boolean;
      }
    ) => Promise<void>;
  } = {}
): Promise<BulkDeleteResult> => {
  const batchSize = opts.batchSize ?? 100;
  const maxTotal = opts.maxTotal ?? 10_000;

  const deletedObjects: Array<{ id: string; objectKey: string }> = [];
  const releasedBlobHashes: string[] = [];
  let truncated = false;

  if (filter.kind === "ids" && filter.ids.length === 0) {
    return { deletedObjects, releasedBlobHashes, truncated };
  }

  // Dedupe caller-supplied ids; also used to remember which ids we've already
  // attempted so the loop terminates under `SKIP LOCKED` contention.
  const pendingIds =
    filter.kind === "ids" ? new Set<string>(filter.ids) : new Set<string>();

  while (deletedObjects.length < maxTotal) {
    const remaining = maxTotal - deletedObjects.length;
    const take = Math.min(batchSize, remaining);

    const batch = await prisma.$transaction(async (tx) => {
      let rows: Array<{ id: string; object_key: string }>;
      if (filter.kind === "prefix") {
        rows = await tx.$queryRaw<Array<{ id: string; object_key: string }>>`
          SELECT "id", "object_key"
          FROM "files"."objects"
          WHERE "bucket_id" = ${bucketId}
            AND "deleted_at" IS NULL
            AND "thumbnail_for" IS NULL
            AND "object_key" LIKE (${escapeLike(filter.prefix)} || '%')
          ORDER BY "id" ASC
          LIMIT ${take}
          FOR NO KEY UPDATE SKIP LOCKED
        `;
      } else {
        if (pendingIds.size === 0) return null;
        const candidateIds = Array.from(pendingIds).slice(0, take);
        // Mark this batch's candidates as no-longer-pending BEFORE executing —
        // so even if `SKIP LOCKED` skips some, we don't retry them in the next
        // iteration and spin forever on contention.
        for (const id of candidateIds) pendingIds.delete(id);
        rows = await tx.$queryRaw<Array<{ id: string; object_key: string }>>`
          SELECT "id", "object_key"
          FROM "files"."objects"
          WHERE "bucket_id" = ${bucketId}
            AND "deleted_at" IS NULL
            AND "thumbnail_for" IS NULL
            AND "id" = ANY(${candidateIds}::uuid[])
          ORDER BY "id" ASC
          FOR NO KEY UPDATE SKIP LOCKED
        `;
      }

      if (rows.length === 0) return null;

      const batchDeleted: Array<{ id: string; objectKey: string }> = [];
      const batchReleased: string[] = [];
      let versioningEnabled = false;
      await lockForRemoval(
        bucketId,
        rows.map((r) => r.id),
        tx
      );
      for (const row of rows) {
        const result = await removeLockedObject(
          bucketId,
          row.id,
          deletedBy,
          tx
        );
        versioningEnabled = result.versioningEnabled;
        batchDeleted.push({ id: row.id, objectKey: row.object_key });
        batchReleased.push(...result.releasedBlobHashes);
      }
      await opts.onBatch?.(tx, { deleted: batchDeleted, versioningEnabled });
      return { deleted: batchDeleted, released: batchReleased };
    });

    if (!batch) break;
    deletedObjects.push(...batch.deleted);
    releasedBlobHashes.push(...batch.released);
  }

  // Prefix-truncation check: the cap is only reachable with a prefix filter
  // (id filters are bounded by the input list). If we did hit the cap, probe
  // for at least one remaining match so callers know to re-invoke.
  if (filter.kind === "prefix" && deletedObjects.length >= maxTotal) {
    const more = await prisma.object.findFirst({
      where: {
        bucketId,
        objectKey: { startsWith: filter.prefix },
        deletedAt: null,
        thumbnailFor: null,
      },
      select: { id: true },
    });
    truncated = !!more;
  }

  return { deletedObjects, releasedBlobHashes, truncated };
};

/**
 * Soft-delete the bucket row. The "fence" that causes:
 *  - `db.buckets.getByName` (which filters `deletedAt: null`) to start returning
 *    404 to any new controller-level upload lookup.
 *  - `upsertWithBlob`'s FOR SHARE re-check on `buckets.deleted_at` to throw a
 *    `ConflictError("bucket deleted")` for any upload that already passed the
 *    controller lookup but hasn't locked the Object row yet.
 *
 * Keeping this a one-row transaction lets us hold no other locks while the
 * subsequent batched version cleanup runs.
 */
export const softDeleteBucket = async (
  bucketId: number,
  deletedBy: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const client = tx ?? prisma;
  // False when a concurrent delete got there first.
  const { count } = await client.bucket.updateMany({
    where: { id: bucketId, deletedAt: null },
    data: { deletedAt: new Date(), deletedBy },
  });
  return count > 0;
};

/**
 * Release a single batch of live blob references in a bucket. Returns:
 *  - `processed`: how many versions were soft-deleted this batch. 0 means the
 *    caller's loop should stop.
 *  - `freedHashes`: hashes whose refCount hit 0 after this batch, ready for
 *    post-commit orphan-cleanup enqueue.
 *
 * Strategy (inside a single short transaction):
 *  1. `SELECT id, content_blob_hash FROM object_versions ... WHERE ... LIMIT 500 FOR UPDATE`
 *     — locks only this slice.
 *  2. `updateMany` soft-deletes those exact rows.
 *  3. Batched `UPDATE content_blobs SET ref_count = GREATEST(0, ref_count - cnt)`
 *     aggregated per-hash so each hash takes a single `ref_count` decrement
 *     regardless of how many of its references we released.
 *  4. Return hashes whose post-update refCount reached 0 so the caller can
 *     enqueue orphan-cleanup.
 *
 * The caller is responsible for looping until `hasMore` is false. A batch
 * shorter than `batchSize` with `hasMore` set means the remaining versions
 * are row-locked by another writer.
 *
 * Releases nothing in a bucket `softDeleteBucket` has not deleted: until
 * then, uploads can still add references behind its back.
 */
export const releaseBucketBlobRefsBatch = async (
  bucketId: number,
  deletedBy: string,
  batchSize: number
): Promise<{ processed: number; freedHashes: string[]; hasMore: boolean }> => {
  return await prisma.$transaction(async (tx) => {
    // Lock this batch of rows under their parent object rows. Using FOR UPDATE
    // SKIP LOCKED means we can run batches concurrently and against an active
    // lifecycle-sweep without deadlocking.
    const rows = await tx.$queryRaw<
      { id: string; content_blob_hash: string }[]
    >`
      SELECT ov."id", ov."content_blob_hash"
      FROM "files"."object_versions" ov
      INNER JOIN "files"."objects" o ON o."id" = ov."object_id"
      INNER JOIN "files"."buckets" b ON b."id" = o."bucket_id"
      WHERE o."bucket_id" = ${bucketId}
        AND b."deleted_at" IS NOT NULL
        AND ov."deleted_at" IS NULL
        AND ov."is_delete_marker" = false
        AND ov."content_blob_hash" IS NOT NULL
      ORDER BY ov."id" ASC
      LIMIT ${batchSize}
      FOR UPDATE OF ov SKIP LOCKED
    `;

    // A short batch means the rest are either gone or row-locked by another
    // writer (SKIP LOCKED); only a plain read tells which.
    const anyLeft = async () => {
      const [{ exists }] = await tx.$queryRaw<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM "files"."object_versions" ov
          INNER JOIN "files"."objects" o ON o."id" = ov."object_id"
          INNER JOIN "files"."buckets" b ON b."id" = o."bucket_id"
          WHERE o."bucket_id" = ${bucketId}
            AND b."deleted_at" IS NOT NULL
            AND ov."deleted_at" IS NULL
            AND ov."is_delete_marker" = false
            AND ov."content_blob_hash" IS NOT NULL
        ) AS "exists"
      `;
      return exists;
    };

    if (rows.length === 0)
      return { processed: 0, freedHashes: [], hasMore: await anyLeft() };

    const versionIds = rows.map((r) => r.id);

    await tx.objectVersion.updateMany({
      where: { id: { in: versionIds } },
      data: { deletedAt: new Date(), deletedBy },
    });

    const decremented = await contentBlobs.decRefMany(
      rows.map((r) => r.content_blob_hash),
      tx
    );
    const freedHashes = decremented
      .filter((r) => r.refCount === 0)
      .map((r) => r.hash);

    return {
      processed: rows.length,
      freedHashes,
      hasMore: rows.length >= batchSize || (await anyLeft()),
    };
  });
};
