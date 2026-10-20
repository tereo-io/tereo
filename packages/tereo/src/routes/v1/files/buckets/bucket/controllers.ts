import { broadcastBucketInvalidate } from "../../../../../utils/cacheBroadcast.js";
import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { setAccessLog } from "../../../../../middleware/accessLog.js";
import { hasPermission } from "../../../../../utils/permissions.js";
import { enqueueBucketCleanup } from "../../../../../jobs/index.js";
import { validateUser } from "../../../../../middleware/auth.js";
import { logger } from "../../../../../utils/logger.js";
import { updateBucketSchema } from "./schemas.js";
import db from "../../../../../utils/db/index.js";
import { bucketNameSchema } from "../schemas.js";
import { Request, Response } from "express";
import {
  Bucket,
  BucketPolicy,
} from "../../../../../../prisma/generated/client/index.js";
import {
  assertBucketDeletable,
  assertDeclaredFieldsUnchanged,
  getManagedBucket,
  validateBucketManagement,
} from "../../../../../utils/bucketAccess.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../../utils/errors.js";
import {
  computeChanges,
  logAuditTx,
  emitTx,
} from "../../../../../utils/outbox.js";
import {
  toOrgRef,
  toServiceRef,
  toUserRef,
  type OrgRef,
  type ServiceRef,
  type UserRef,
} from "../../../../../utils/refs.js";

export function serializeBucket(
  bucket: Bucket & {
    service: ServiceRef | null;
    creator: UserRef;
    organization: OrgRef | null;
  },
  liveUsageBytes?: bigint
) {
  return {
    id: bucket.id,
    name: bucket.name,
    description: bucket.description,
    policy: bucket.policy,
    storageQuotaBytes: bucket.storageQuotaBytes?.toString(),
    currentUsageBytes: bucket.currentUsageBytes.toString(),
    // Only emitted for versioning-enabled buckets. Equals the sum of blob
    // sizes across live *current* (non-delete-marker) versions. For
    // versioning-off buckets `currentUsageBytes` is already the live figure,
    // so there's no second number to report.
    liveUsageBytes:
      bucket.versioningEnabled && liveUsageBytes !== undefined
        ? liveUsageBytes.toString()
        : undefined,
    versioningEnabled: bucket.versioningEnabled,
    autoThumbnails: bucket.autoThumbnails,
    corsConfig: bucket.corsConfig,
    rateLimitConfig: bucket.rateLimitConfig,
    organizationId: bucket.organizationId,
    organization: toOrgRef(bucket.organization),
    createdBy: bucket.createdBy,
    creator: toUserRef(bucket.creator),
    serviceId: bucket.serviceId,
    serviceName: bucket.service?.name ?? null,
    service: toServiceRef(bucket.service),
    missingSince: bucket.missingSince,
    retiredAt: bucket.retiredAt,
    createdAt: bucket.createdAt,
    updatedAt: bucket.updatedAt,
  };
}

/**
 * Get bucket details
 * GET /buckets/:name
 */
export const getBucket = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);

  await validateBucketManagement(auth, name, "read");
  const bucket = await db.buckets.getByNameWithService(name);

  setAccessLog(res, { bucketId: bucket.id, operation: "GET_BUCKET" });

  // Only pay for the live-bytes SUM when the bucket actually has history to
  // split out. In a versioning-off bucket current=live by construction.
  const liveUsageBytes = bucket.versioningEnabled
    ? await db.buckets.getLiveUsageBytes(bucket.id)
    : undefined;

  res.json(serializeBucket(bucket, liveUsageBytes));
};

/**
 * Update bucket
 * PUT /buckets/:name
 */
export const updateBucket = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const body = validateBody(updateBucketSchema, req);

  // With the service, like `update` returns it: computeChanges diffs the two.
  await validateBucketManagement(auth, name, "write");
  const bucket = await db.buckets.getByNameWithService(name);
  assertDeclaredFieldsUnchanged(bucket, body);

  // Disallow flipping versioningEnabled from true -> false while historical
  // versions still exist. Otherwise those rows (and the blob refs they hold)
  // become invisible to the normal write paths — lifecycle is the only thing
  // that cleans them up, and the UI gives no indication they still exist.
  // The operator must clear history first (e.g. set `expireVersionsAfterDays`
  // on a lifecycle policy and let the sweep drain the non-current rows).
  // Checked under the bucket's lock, which every upload and delete takes
  // before reading the setting: one that commits history first is seen here,
  // and one that commits after goes by the new setting.
  const updated = await db.$transaction(async (tx) => {
    if (body.versioningEnabled === false) {
      const locked = await db.buckets.lockForWrite(bucket.id, tx);
      if (
        locked?.versioningEnabled &&
        (await db.objectVersions.hasHistoricalVersions(bucket.id, tx))
      ) {
        throw new BadRequestError(
          "versioning_disable_blocked",
          "Cannot disable versioning while historical versions exist. Clear history first via a lifecycle policy (expireVersionsAfterDays)."
        );
      }
    }

    const next = await db.buckets.update(
      bucket.id,
      {
        description: body.description,
        policy: body.policy as BucketPolicy | undefined,
        storageQuotaBytes: body.storageQuotaBytes,
        versioningEnabled: body.versioningEnabled,
        autoThumbnails: body.autoThumbnails,
        corsConfig: body.corsConfig,
        rateLimitConfig: body.rateLimitConfig,
      },
      tx
    );

    const changes = computeChanges(bucket, next);
    if (changes) {
      await logAuditTx(tx, {
        auth,
        organizationId: next.organizationId ?? undefined,
        action: "UPDATE",
        entityType: "bucket",
        entityId: String(next.id),
        entityName: next.name,
        changes,
        metadata: { bucketName: next.name },
      });
    }

    if (changes && next.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.bucket.updated",
        organizationId: next.organizationId,
        entityType: "bucket",
        entityId: String(next.id),
        data: {
          bucketName: next.name,
        },
      });
    }

    return next;
  });

  setAccessLog(res, { bucketId: updated.id, operation: "UPDATE_BUCKET" });

  // Fleet-wide SDK cache invalidation — consumers drop their cached copy.
  await broadcastBucketInvalidate(updated.name);

  res.json(serializeBucket(updated));
};

/**
 * Delete bucket (soft delete)
 * DELETE /buckets/:name
 */
export const deleteBucket = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);

  const bucket = await getManagedBucket(auth, name, "delete");

  setAccessLog(res, { bucketId: bucket.id, operation: "DELETE_BUCKET" });

  // Phase 1 (sync): flip the bucket to deleted. This is the fence — new
  // uploads arriving after this commit will fail at `getByName` (controller
  // pre-check) or at the `FOR SHARE` recheck inside `upsertWithBlob`,
  // preventing new versions from being inserted while the background cleanup
  // releases refs below.
  await db.$transaction(async (tx) => {
    await assertBucketDeletable(bucket, tx);
    if (!(await db.objects.softDeleteBucket(bucket.id, auth.userId, tx))) {
      throw new NotFoundError("Bucket not found");
    }

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "DELETE",
      entityType: "bucket",
      entityId: String(bucket.id),
      entityName: bucket.name,
      metadata: {
        bucketName: bucket.name,
        policy: bucket.policy,
      },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.bucket.deleted",
        organizationId: bucket.organizationId,
        entityType: "bucket",
        entityId: String(bucket.id),
        data: { bucketName: bucket.name },
      });
    }
  });

  await broadcastBucketInvalidate(bucket.name);

  // Phase 2 (async): defer the (potentially multi-minute) blob-ref release +
  // orphan-cleanup enqueue to the `bucket-cleanup` BullMQ worker so the HTTP
  // caller isn't blocked. A failed enqueue is picked up by the hourly
  // `bucket-cleanup-reconcile` job, which finds deleted buckets still
  // holding refs.
  enqueueBucketCleanup(bucket.id, auth.userId).catch((error) => {
    logger.warn(
      {
        bucketId: bucket.id,
        err: error,
      },
      "bucket-cleanup enqueue failed"
    );
  });

  res.status(204).send();
};

/**
 * Get current user's permissions for a bucket
 * GET /buckets/:name/my-permissions
 */
export const getMyPermissions = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);

  const isAdmin = hasPermission(auth.permissions, PERMISSIONS.admin);

  // Same organization isolation as object access; another org's bucket is
  // refused exactly like a missing one.
  const found = await db.buckets.checkByName(name);
  if (
    !isAdmin &&
    (!found ||
      (found.organizationId && found.organizationId !== auth.organizationId))
  ) {
    throw new ForbiddenError("Insufficient permissions to read bucket");
  }
  const bucket = found ?? (await db.buckets.getByName(name));
  setAccessLog(res, { bucketId: bucket.id, operation: "GET_MY_PERMISSIONS" });

  // A retired bucket is read-only for everyone (`assertBucketWritable`).
  const writable = !bucket.retiredAt;

  if (isAdmin) {
    return res.json({ canRead: true, canWrite: writable, canDelete: true });
  }

  const grant = await db.bucketPermissions.getByBucketAndUser(
    bucket.id,
    auth.userId
  );
  const active = grant && !grant.revokedAt ? grant : null;

  // What the object routes would let the caller do: the grant and the role
  // permission they require with it (already cut to a delegated token's
  // ceiling). A public bucket is readable with neither.
  const may = (operation: "read" | "write" | "delete") =>
    hasPermission(auth.permissions, PERMISSIONS.objects[operation]);
  res.json({
    canRead:
      bucket.policy === "public" || ((active?.canRead ?? false) && may("read")),
    canWrite: writable && (active?.canWrite ?? false) && may("write"),
    canDelete: (active?.canDelete ?? false) && may("delete"),
  });
};
