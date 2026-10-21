import { broadcastObjectInvalidate } from "../../../../../../utils/cacheBroadcast.js";
import { enqueueOrphanBlobCleanupSafe } from "../../../../../../jobs/index.js";
import { setAccessLog } from "../../../../../../middleware/accessLog.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { withUserRefs } from "../../../../../../utils/users.js";
import db from "../../../../../../utils/db/index.js";
import { bucketNameSchema } from "../../schemas.js";
import { Request, Response } from "express";
import {
  getAccessibleBucket,
  getReadableBucket,
  isBucketReader,
} from "../../../../../../utils/bucketAccess.js";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../../utils/validateReq.js";
import {
  bucketEventScope,
  logAuditTx,
  emitTx,
} from "../../../../../../utils/outbox.js";
import {
  BadRequestError,
  ForbiddenError,
} from "../../../../../../utils/errors.js";
import {
  applyCursorToWhere,
  decodeListCursor,
  encodeListCursor,
} from "../../../../../../utils/cursor.js";
import {
  bulkDeleteBodySchema,
  listObjectsExtraQuerySchema,
  listObjectsQuerySchema,
  listPrefixesQuerySchema,
} from "./schemas.js";
import {
  seesBucketHistory,
  serializeDeletedObject,
  serializeObject,
} from "./utils.js";

/**
 * List objects in a bucket
 * GET /buckets/:name/objects
 */
export const listObjects = async (req: Request, res: Response) => {
  const { name } = validateParams(bucketNameSchema, req);

  const bucket = await getReadableBucket(req, name);

  setAccessLog(res, { bucketId: bucket.id, operation: "LIST_OBJECTS" });

  const query = validateQuery(listObjectsQuerySchema, req);
  const { deleted } = validateQuery(listObjectsExtraQuerySchema, req);

  if (deleted) {
    if (!(await seesBucketHistory(req, bucket))) {
      validateUser(req);
      throw new ForbiddenError(
        "Listing deleted objects takes read access to the bucket"
      );
    }
    // A deleted object's current version is its delete marker: no content
    // to size.
    if (query.sort === "sizeBytes") {
      throw new BadRequestError(
        "invalid_sort",
        "Deleted objects cannot be sorted by sizeBytes"
      );
    }
    const result = await db.objects.getDeletedPaginated({
      bucketId: bucket.id,
      take: query.limit,
      orderBy: query.orderBy,
      where: applyCursorToWhere(query),
    });
    const named = (await isBucketReader(req, bucket.name))
      ? await withUserRefs(result.data, { deletedByUser: "deletedBy" })
      : result.data.map((o) => ({ ...o, deletedByUser: null }));
    const lastRow = result.data[result.data.length - 1];
    res.json({
      data: named.map(serializeDeletedObject),
      hasMore: result.hasMore,
      limit: query.limit,
      nextCursor:
        result.hasMore && lastRow
          ? encodeListCursor({
              sort: query.sort,
              sortDir: query.sortDir,
              sortValue: (lastRow as unknown as Record<string, unknown>)[
                query.sortPrismaField
              ],
              id: lastRow.id,
            })
          : null,
    });
    return;
  }

  // `sizeBytes` lives on content_blobs; Prisma can't sort there, so the raw-SQL
  // path in `getPaginated` needs a pre-decoded cursor of (bigint, uuid).
  let sizeBytesCursor:
    { sizeBytes: bigint; id: string; dir: "asc" | "desc" } | undefined;
  if (query.sort === "sizeBytes" && query.cursor) {
    const decoded = decodeListCursor(query.cursor, {
      sort: query.sort,
      sortDir: query.sortDir,
    });
    // Payload k is `unknown`; a valid-HMAC but malformed cursor (e.g. from a
    // buggy client that encoded `null` or a non-numeric string) would crash
    // BigInt() with a SyntaxError. Surface that as 400 invalid_cursor rather
    // than a 500 with a stack trace.
    let sizeBytes: bigint;
    try {
      sizeBytes = BigInt(decoded.k as string | number);
    } catch {
      throw new BadRequestError(
        "invalid_cursor",
        "Cursor payload is malformed"
      );
    }
    sizeBytesCursor = {
      sizeBytes,
      id: String(decoded.id),
      dir: decoded.d,
    };
  }

  // For non-sizeBytes sorts, let the shared helper merge cursor into filter where.
  const where =
    query.sort === "sizeBytes" ? query.where : applyCursorToWhere(query);

  const result = await db.objects.getPaginated({
    bucketId: bucket.id,
    take: query.limit,
    orderBy: query.orderBy,
    where,
    sizeBytesCursor,
  });

  const lastRow = result.data[result.data.length - 1];
  let nextCursor: string | null = null;
  if (result.hasMore && lastRow) {
    const sortValue =
      query.sort === "sizeBytes"
        ? (lastRow.versions[0]?.contentBlob?.sizeBytes.toString() ?? "0")
        : (lastRow as unknown as Record<string, unknown>)[
            query.sortPrismaField
          ];
    nextCursor = encodeListCursor({
      sort: query.sort,
      sortDir: query.sortDir,
      sortValue,
      id: lastRow.id,
    });
  }

  res.json({
    data: result.data.map(serializeObject),
    hasMore: result.hasMore,
    limit: query.limit,
    nextCursor,
  });
};

/**
 * List virtual folders (prefixes) + leaf objects under a prefix. Powers the
 * admin UI tree view. Cheap and additive — no schema change required.
 *
 * GET /buckets/:name/objects/prefixes
 */
export const listObjectPrefixes = async (req: Request, res: Response) => {
  const { name } = validateParams(bucketNameSchema, req);
  const query = validateQuery(listPrefixesQuerySchema, req);

  const bucket = await getReadableBucket(req, name);

  setAccessLog(res, { bucketId: bucket.id, operation: "LIST_OBJECT_PREFIXES" });

  // The prefix listing has two independent result sets (folders + leaf objects)
  // so the cursor encodes both sub-positions. Folder sort key is the segment
  // (ASC), object sort key is the object_key (ASC); no HMAC-bound sort/dir
  // since the ordering is fixed.
  // A set that ran out on an earlier page is marked done (`fd` / `od`), so
  // later pages don't list it again from the start.
  let folderCursor: string | undefined;
  let objectCursor: string | undefined;
  let exhausted: { folders?: boolean; objects?: boolean } = {};
  if (query.cursor) {
    const decoded = decodeListCursor(query.cursor, {
      sort: "prefixes",
      sortDir: "asc",
    });
    const both = decoded.k as
      | { f?: string | null; o?: string | null; fd?: boolean; od?: boolean }
      | undefined;
    folderCursor = both?.f ?? undefined;
    objectCursor = both?.o ?? undefined;
    exhausted = { folders: both?.fd === true, objects: both?.od === true };
  }

  const result = await db.objects.listPrefixes(
    bucket.id,
    query.prefix,
    query.delimiter,
    query.limit,
    folderCursor,
    objectCursor,
    exhausted
  );

  const hasMore = result.foldersHasMore || result.objectsHasMore;
  const nextCursor = hasMore
    ? encodeListCursor({
        sort: "prefixes",
        sortDir: "asc",
        sortValue: {
          f: result.lastFolderSegment,
          o: result.lastObjectKey,
          fd: !result.foldersHasMore,
          od: !result.objectsHasMore,
        },
        id: "",
      })
    : null;

  // Unified envelope: folders (prefixes) come first, then leaf objects.
  // Each entry carries a `type` discriminator so callers can render a single
  // ordered list without managing two sub-streams.
  const data = [
    ...result.prefixes.map((p) => ({ type: "prefix" as const, ...p })),
    ...result.objects.map((o) => ({ type: "object" as const, ...o })),
  ];

  res.json({
    data,
    hasMore,
    limit: query.limit,
    nextCursor,
  });
};

/**
 * POST /buckets/:name/objects/bulk-delete
 *
 * Soft-deletes many objects in one request. Body is a discriminated union:
 *   - `{ prefix: "images/2024/" }`   — delete every object whose key starts
 *     with the given prefix. Server caps one request at 10,000 objects and
 *     returns `truncated=true` when more remain; the UI should re-invoke.
 *   - `{ ids: [uuid, ...] }`         — delete the exact set of object ids
 *     (max 1000). IDs not matching a live object are silently ignored.
 *
 * Per-object semantics match `DELETE /buckets/:name/objects/by-id/:id`: in a
 * versioned bucket a delete-marker is inserted; in a non-versioned bucket the
 * current version row is dropped and its blob's refcount decremented. One
 * audit entry and one webhook event are written per batch of up to 100
 * objects, in the batch's transaction (per-object events would flood webhook
 * consumers on large folder deletes); cache invalidation is broadcast per key
 * so SDK consumers drop their cached rows promptly.
 */
export const bulkDeleteObjects = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const body = validateBody(bulkDeleteBodySchema, req);

  const bucket = await getAccessibleBucket(auth, name, "delete");

  const filter =
    body.prefix !== undefined
      ? ({ kind: "prefix", prefix: body.prefix } as const)
      : ({ kind: "ids", ids: body.ids ?? [] } as const);

  const entityName =
    filter.kind === "prefix" ? filter.prefix : `${bucket.name} ids`;
  let batchIndex = 0;
  // An audit entry and an event per batch, in the batch's transaction: a
  // request stopped part-way leaves both for every delete that committed.
  const result = await db.objects.removeObjectsBulk(
    bucket.id,
    filter,
    auth.userId,
    {
      onBatch: async (tx, batch) => {
        const index = batchIndex++;
        await logAuditTx(tx, {
          auth,
          organizationId: bucket.organizationId ?? undefined,
          action: "DELETE",
          entityType: "objects_bulk",
          entityId: bucket.id.toString(),
          entityName,
          metadata: {
            bucketName: bucket.name,
            filter,
            deletedCount: batch.deleted.length,
            objects: batch.deleted,
            versionedTombstone: batch.versioningEnabled,
          },
        });
        await emitTx(tx, {
          eventType: "file-service.objects.bulk-deleted",
          ...bucketEventScope(bucket),
          entityType: "bucket",
          entityId: String(bucket.id),
          data: {
            bucketName: bucket.name,
            filter,
            batchIndex: index,
            deletedCount: batch.deleted.length,
            versionedTombstone: batch.versioningEnabled,
            objects: batch.deleted,
          },
        });
      },
    }
  );

  setAccessLog(res, {
    bucketId: bucket.id,
    operation: "BULK_DELETE_OBJECTS",
  });

  // `releasedBlobHashes` contains duplicates (each N-ref blob appears N times
  // in the loop). `removeLockedObject` calls `decRef` on each, so the counts
  // match the actual ref releases; dedupe before enqueuing orphan cleanup so
  // the worker doesn't do repeated no-op scans on the same hash.
  const uniqueReleased = Array.from(new Set(result.releasedBlobHashes));
  for (const hash of uniqueReleased) {
    enqueueOrphanBlobCleanupSafe(hash);
  }

  // Per-key cache invalidation so SDK consumers drop their cached rows.
  // Fire-and-forget (the helper already swallows errors); awaiting in sequence
  // keeps the Redis pipeline bounded for very large deletes.
  for (const obj of result.deletedObjects) {
    await broadcastObjectInvalidate(bucket.name, obj.objectKey);
  }

  res.json({
    deletedCount: result.deletedObjects.length,
    truncated: result.truncated,
  });
};

/**
 * POST /buckets/:name/objects/purge-non-current-versions
 *
 * Soft-deletes every non-current, live `ObjectVersion` row in the bucket and
 * releases its blob ref. The orphan-blob worker reclaims the bytes after the
 * configured grace period. Capped at 10,000 versions per request — when the
 * cap is hit the response sets `truncated: true` and the UI should re-invoke.
 *
 * The current version of every object is untouched, so callers who only ever
 * read the latest content see no change. One audit entry and one webhook
 * event per batch, matching `bulk-delete`.
 */
export const purgeNonCurrentVersions = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);

  const bucket = await getAccessibleBucket(auth, name, "delete");

  let batchIndex = 0;
  // An audit entry and an event per batch, in the batch's transaction, as
  // bulk delete.
  const result = await db.objectVersions.purgeNonCurrentBulk(
    bucket.id,
    auth.userId,
    bucket.versioningEnabled,
    {
      onBatch: async (tx, batch) => {
        const index = batchIndex++;
        await logAuditTx(tx, {
          auth,
          organizationId: bucket.organizationId ?? undefined,
          action: "DELETE",
          entityType: "object_versions_purge",
          entityId: bucket.id.toString(),
          entityName: bucket.name,
          metadata: {
            bucketName: bucket.name,
            purgedCount: batch.versionIds.length,
            bytesFreed: batch.bytesFreed.toString(),
            versionIds: batch.versionIds,
          },
        });
        await emitTx(tx, {
          eventType: "file-service.objects.versions.purged",
          ...bucketEventScope(bucket),
          entityType: "bucket",
          entityId: String(bucket.id),
          data: {
            bucketName: bucket.name,
            batchIndex: index,
            purgedCount: batch.versionIds.length,
            bytesFreed: batch.bytesFreed.toString(),
            versionIds: batch.versionIds,
          },
        });
      },
    }
  );

  setAccessLog(res, {
    bucketId: bucket.id,
    operation: "PURGE_NON_CURRENT_VERSIONS",
  });

  // `releasedBlobHashes` may contain duplicates (each N-ref blob appears N
  // times in the loop). The decRef calls above match the count, but enqueue
  // orphan cleanup on the deduped set so the worker doesn't repeat no-op
  // scans.
  const uniqueReleased = Array.from(new Set(result.releasedBlobHashes));
  for (const hash of uniqueReleased) {
    enqueueOrphanBlobCleanupSafe(hash);
  }

  res.json({
    purgedCount: result.purgedCount,
    bytesFreed: result.bytesFreed.toString(),
    truncated: result.truncated,
  });
};
