import { getShareSweepQueue, SHARE_SWEEP_QUEUE } from "./queues.js";
import { createTimeBoxedLoop, isShuttingDown } from "./jobUtils.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logAuditTx } from "../utils/outbox.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import env from "../env.js";

// Daily — share rows that go past `FILE_SERVICE_SHARE_RETENTION_DAYS` past
// their revoked_at / expires_at lapse their audit value (the trail itself
// lives in the audit log). One run per day is enough; the grace window
// is measured in days.
const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 500;

let worker: Worker | null = null;

/**
 * Gives the shares still without an expiry the longest one allowed, with one
 * audit entry per bucket they are on.
 */
const backfillShareExpiry = async (): Promise<number> =>
  await db.$transaction(async (tx) => {
    const filled = await db.shares.backfillExpiry(
      env.FILE_SERVICE_MAX_SHARE_TTL_SECONDS,
      tx
    );
    if (filled.length === 0) return 0;
    const buckets = await tx.bucket.findMany({
      where: { id: { in: [...new Set(filled.map((s) => s.bucketId))] } },
      select: { id: true, name: true, organizationId: true },
    });
    for (const bucket of buckets) {
      const shares = filled.filter((s) => s.bucketId === bucket.id);
      await logAuditTx(tx, {
        auth: { userId: SYSTEM_USER_ID, email: null },
        organizationId: bucket.organizationId,
        action: "UPDATE",
        entityType: "shareExpiryBackfill",
        entityId: String(bucket.id),
        entityName: bucket.name,
        metadata: {
          bucketName: bucket.name,
          maxTtlSeconds: env.FILE_SERVICE_MAX_SHARE_TTL_SECONDS,
          processed: shares.length,
          shares: shares.map((s) => ({ id: s.id, expiresAt: s.expiresAt })),
        },
      });
    }
    return filled.length;
  });

export async function processShareSweepTick(): Promise<{
  processed: number;
  hasMore: boolean;
}> {
  await backfillShareExpiry();
  const graceMs = env.FILE_SERVICE_SHARE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const processed = await db.$transaction(async (tx) => {
    const deleted = await db.shares.deleteExpired(
      graceMs,
      new Date(),
      BATCH_LIMIT,
      tx
    );
    // One entry per bucket in the batch, so each lands in its organization's
    // audit log.
    const byBucket = new Map<number, typeof deleted>();
    for (const share of deleted) {
      const group = byBucket.get(share.bucket.id) ?? [];
      group.push(share);
      byBucket.set(share.bucket.id, group);
    }
    for (const shares of byBucket.values()) {
      const { bucket } = shares[0];
      await logAuditTx(tx, {
        auth: { userId: SYSTEM_USER_ID, email: null },
        organizationId: bucket.organizationId,
        action: "DELETE",
        entityType: "shareSweep",
        entityId: String(bucket.id),
        entityName: bucket.name,
        metadata: {
          bucketName: bucket.name,
          retentionDays: env.FILE_SERVICE_SHARE_RETENTION_DAYS,
          processed: shares.length,
          shares: shares.map((s) => ({ id: s.id, kind: s.kind })),
        },
      });
    }
    return deleted.length;
  });
  return { processed, hasMore: processed >= BATCH_LIMIT };
}

async function processShareSweepJob(job: Job): Promise<void> {
  if (isShuttingDown()) return;
  const result = await createTimeBoxedLoop<null>({
    job,
    tick: async () => {
      const { processed, hasMore } = await processShareSweepTick();
      return { hasMore, processed };
    },
  });
  logger.info(
    {
      iterations: result.iterations,
      totalProcessed: result.totalProcessed,
      completed: result.completed,
    },
    "Share sweep completed"
  );
}

export async function startShareSweep(): Promise<void> {
  const queue = getShareSweepQueue();
  worker = new TrackedWorker(
    SHARE_SWEEP_QUEUE,
    async (job) => {
      await processShareSweepJob(job);
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Share sweep failed"
    );
  });

  await queue.upsertJobScheduler(
    "share-sweep-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "share-sweep" }
  );
  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
      retentionDays: env.FILE_SERVICE_SHARE_RETENTION_DAYS,
    },
    "Share sweep worker started"
  );
}

export async function stopShareSweep(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
