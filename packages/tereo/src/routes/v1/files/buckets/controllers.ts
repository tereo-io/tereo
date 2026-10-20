import { broadcastBucketInvalidate } from "../../../../utils/cacheBroadcast.js";
import { BucketPolicy } from "../../../../../prisma/generated/client/index.js";
import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { assertBucketNameUnreserved } from "../../../../utils/registry.js";
import { createBucketSchema, listBucketsQuerySchema } from "./schemas.js";
import { setAccessLog } from "../../../../middleware/accessLog.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { BadRequestError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../middleware/auth.js";
import { serializeBucket } from "./bucket/controllers.js";
import db from "../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  applyCursorToWhere,
  buildCursorWhere,
  decodeListCursor,
  encodeListCursor,
  mergeCursorWhere,
} from "../../../../utils/cursor.js";

type ListBucketsQuery = ReturnType<typeof listBucketsQuerySchema.parse>;

/**
 * `currentUsageBytes` is a BigInt, which the cursor carries as a string; it
 * is turned back into one before the shared keyset clause is built.
 */
const bucketCursorWhere = (query: ListBucketsQuery) => {
  if (!query.cursor || query.sort !== "currentUsageBytes") {
    return applyCursorToWhere(query);
  }
  const decoded = decodeListCursor(query.cursor, {
    sort: query.sort,
    sortDir: query.sortDir,
  });
  let k: bigint;
  try {
    k = BigInt(decoded.k as string);
  } catch {
    throw new BadRequestError("invalid_cursor", "Cursor payload is malformed");
  }
  return mergeCursorWhere(
    query.where,
    buildCursorWhere({ ...decoded, k }, query.sortPrismaField, query.tiebreaker)
  );
};

export const listBuckets = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const query = validateQuery(listBucketsQuerySchema, req);

  const where = bucketCursorWhere(query);

  const result = await db.buckets.getPaginated({
    userId: auth.userId,
    organizationId: auth.organizationId ?? undefined,
    isAdmin: hasPermission(auth.permissions, "file-service.admin"),
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  const lastRow = result.data[result.data.length - 1];
  const nextCursor =
    result.hasMore && lastRow
      ? encodeListCursor({
          sort: query.sort,
          sortDir: query.sortDir,
          sortValue:
            query.sort === "currentUsageBytes"
              ? lastRow.currentUsageBytes.toString()
              : (lastRow as unknown as Record<string, unknown>)[
                  query.sortPrismaField
                ],
          id: lastRow.id,
        })
      : null;

  res.json({
    data: result.data.map((b) => serializeBucket(b)),
    hasMore: result.hasMore,
    limit: query.limit,
    nextCursor,
  });
};

export const createBucket = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(createBucketSchema, req);

  await db.buckets.checkUniqueByName(body.name);

  const bucket = await db.$transaction(async (tx) => {
    await assertBucketNameUnreserved(body.name, tx);
    const created = await db.buckets.create(
      {
        name: body.name,
        description: body.description,
        policy: body.policy as BucketPolicy,
        storageQuotaBytes: body.storageQuotaBytes || undefined,
        createdBy: auth.userId,
        organizationId: auth.organizationId ?? undefined,
      },
      tx
    );

    await logAuditTx(tx, {
      auth,
      organizationId: created.organizationId ?? undefined,
      action: "CREATE",
      entityType: "bucket",
      entityId: String(created.id),
      entityName: created.name,
      metadata: {
        bucketName: created.name,
        policy: created.policy,
      },
    });

    if (created.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.bucket.created",
        organizationId: created.organizationId,
        entityType: "bucket",
        entityId: String(created.id),
        data: {
          bucketName: created.name,
          policy: created.policy,
          versioningEnabled: created.versioningEnabled,
        },
      });
    }

    // The creator's object access is an ordinary grant: listed with the
    // others, and revocable like them.
    const grant = await db.bucketPermissions.create(
      {
        bucketId: created.id,
        userId: auth.userId,
        canRead: true,
        canWrite: true,
        canDelete: true,
        grantedBy: auth.userId,
      },
      tx
    );

    await logAuditTx(tx, {
      auth,
      organizationId: created.organizationId ?? undefined,
      action: "CREATE",
      entityType: "bucketPermission",
      entityId: String(grant.id),
      entityName: `${created.name}:${grant.userId}`,
      metadata: {
        bucketName: created.name,
        targetUserId: grant.userId,
        canRead: grant.canRead,
        canWrite: grant.canWrite,
        canDelete: grant.canDelete,
      },
    });

    if (created.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.permission.granted",
        organizationId: created.organizationId,
        entityType: "bucketPermission",
        entityId: String(grant.id),
        data: {
          bucketName: created.name,
          userId: grant.userId,
          canRead: grant.canRead,
          canWrite: grant.canWrite,
          canDelete: grant.canDelete,
          grantedBy: grant.grantedBy,
        },
      });
    }

    return created;
  });

  setAccessLog(res, { bucketId: bucket.id, operation: "CREATE_BUCKET" });

  // A cache may hold the name's earlier answer: not found, or a deleted
  // bucket of the same name.
  await broadcastBucketInvalidate(bucket.name);

  res.status(201).json(serializeBucket(bucket));
};
