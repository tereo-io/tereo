import { CORE_SERVICE_ID, SYSTEM_USER } from "../definitions/index.js";
import { broadcastBucketInvalidate } from "./cacheBroadcast.js";
import type { BucketDefinition } from "../definitions/types.js";
import { BUCKETS } from "../definitions/buckets.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import db from "./db/index.js";
import {
  bucketEventScope,
  computeChanges,
  emitTx,
  logAuditTx,
} from "./outbox.js";

/**
 * Core's own buckets are read-only through the files API, so nothing an
 * admin tuned on one before that rule (policy, quota, versioning, thumbnails,
 * CORS, rate limit, lifecycle policy, an object's `deleteAfter`) could be
 * undone. Every start puts each back to its declared state; a bucket already
 * there is left untouched. Grants and shares stay: they can be revoked.
 */
export const resetCoreBuckets = async (
  definitions: BucketDefinition[] = BUCKETS
) => {
  for (const definition of definitions) {
    await resetCoreBucket(definition);
  }
};

const resetCoreBucket = async (definition: BucketDefinition) => {
  const bucket = await prisma.bucket.findFirst({
    where: {
      name: definition.bucketName,
      serviceId: CORE_SERVICE_ID,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!bucket) return;

  const { reset, keepVersioning } = await prisma.$transaction(async (tx) => {
    // Objects before the bucket row, the order every object write and the
    // expiry sweep take them in.
    const { count: expiriesCleared } = definition.managesObjectExpiry
      ? { count: 0 }
      : await tx.object.updateMany({
          where: { bucketId: bucket.id, deleteAfter: { not: null } },
          data: { deleteAfter: null },
        });
    const current = await db.buckets.getForUpdate(bucket.id, tx);
    // Versioning goes off only without history, which would otherwise become
    // unreachable. Old versions are never deleted here.
    const keepVersioning =
      current.versioningEnabled &&
      (await db.objectVersions.hasHistoricalVersions(bucket.id, tx));
    const declared = {
      policy: definition.policy,
      storageQuotaBytes:
        definition.storageQuotaBytes === undefined
          ? null
          : BigInt(definition.storageQuotaBytes),
      versioningEnabled: keepVersioning,
      autoThumbnails: false,
      corsConfig: null,
      rateLimitConfig: null,
    };
    const settingsChanged =
      computeChanges(pick(current, declared), declared) !== undefined;
    const next = settingsChanged
      ? await db.buckets.update(bucket.id, declared, tx)
      : current;
    const lifecyclePolicyRemoved = await db.lifecyclePolicies.remove(
      bucket.id,
      tx
    );

    const changes = computeChanges(current, next);
    if (!changes && !lifecyclePolicyRemoved && !expiriesCleared) {
      return { reset: null, keepVersioning };
    }
    const summary = {
      bucketName: next.name,
      via: "core_bucket_reset",
      lifecyclePolicyRemoved,
      expiriesCleared,
      ...(keepVersioning ? { versioningKept: true } : {}),
    };
    await logAuditTx(tx, {
      auth: { userId: SYSTEM_USER.id, email: null },
      action: "UPDATE",
      entityType: "bucket",
      entityId: String(next.id),
      entityName: next.name,
      changes,
      metadata: summary,
    });
    await emitTx(tx, {
      eventType: "file-service.bucket.updated",
      ...bucketEventScope(next),
      entityType: "bucket",
      entityId: String(next.id),
      data: { bucketName: next.name },
    });
    return {
      reset: { ...summary, changed: Object.keys(changes ?? {}) },
      keepVersioning,
    };
  });

  if (reset) {
    await broadcastBucketInvalidate(definition.bucketName);
    logger.warn(reset, "Reset a core bucket to its declared settings");
  }
  if (keepVersioning) {
    logger.warn(
      { bucketName: definition.bucketName },
      "A core bucket has object history, so its versioning stays on; old versions are kept. A file-service.admin can purge them (POST /v1/files/buckets/:name/objects/purge-non-current-versions), and the next start turns versioning off"
    );
  }
};

const pick = (row: object, shape: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.keys(shape).map((k) => [k, (row as Record<string, unknown>)[k]])
  );
