import { ARCHIVE_SWEEP_QUEUE, getArchiveSweepQueue } from "./queues.js";
import { createTimeBoxedLoop, isShuttingDown } from "./jobUtils.js";
import { revokeShareTx } from "../utils/shareRevocation.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logAuditTx } from "../utils/outbox.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import env from "../env.js";

// Daily, on the share sweep's grace: an archive is kept as long as a share
// pointing at it would be, so a share listing still shows its archive.
const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 500;
const SYSTEM_ACTOR = { userId: SYSTEM_USER_ID, email: null };

let worker: Worker | null = null;

async function processArchiveSweepTick(now: Date = new Date()): Promise<{
  processed: number;
  hasMore: boolean;
}> {
  const graceMs = env.FILE_SERVICE_SHARE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const processed = await db.$transaction(async (tx) => {
    const expired = await db.archives.findExpired(
      graceMs,
      now,
      BATCH_LIMIT,
      tx
    );
    if (expired.length === 0) return 0;

    // Their shares cascade with the delete; one still live is revoked first,
    // audited and emitted like any other revoke.
    for (const archive of expired) {
      for (const share of archive.shares) {
        if (share.revokedAt) continue;
        if (share.expiresAt && share.expiresAt <= now) continue;
        await revokeShareTx(
          tx,
          SYSTEM_ACTOR,
          { id: share.id, kind: share.kind, bucket: archive.bucket },
          "archive_expired"
        );
      }
    }
    const deleted = await db.archives.deleteMany(
      expired.map((a) => a.id),
      tx
    );

    // One entry per bucket in the batch, so each lands in its organization's
    // audit log.
    const byBucket = new Map<number, typeof expired>();
    for (const archive of expired) {
      const group = byBucket.get(archive.bucket.id) ?? [];
      group.push(archive);
      byBucket.set(archive.bucket.id, group);
    }
    for (const archives of byBucket.values()) {
      const { bucket } = archives[0];
      await logAuditTx(tx, {
        auth: SYSTEM_ACTOR,
        organizationId: bucket.organizationId,
        action: "DELETE",
        entityType: "archiveSweep",
        entityId: String(bucket.id),
        entityName: bucket.name,
        metadata: {
          bucketName: bucket.name,
          retentionDays: env.FILE_SERVICE_SHARE_RETENTION_DAYS,
          processed: archives.length,
          archives: archives.map((a) => ({
            id: a.id,
            filename: a.filename,
            expiresAt: a.expiresAt,
            shareIds: a.shares.map((s) => s.id),
          })),
        },
      });
    }
    return deleted;
  });
  return { processed, hasMore: processed >= BATCH_LIMIT };
}

async function processArchiveSweepJob(job: Job): Promise<void> {
  if (isShuttingDown()) return;
  const result = await createTimeBoxedLoop<null>({
    job,
    tick: async () => {
      const { processed, hasMore } = await processArchiveSweepTick();
      return { hasMore, processed };
    },
  });
  logger.info(
    {
      iterations: result.iterations,
      totalProcessed: result.totalProcessed,
      completed: result.completed,
    },
    "Archive sweep completed"
  );
}

export async function startArchiveSweep(): Promise<void> {
  const queue = getArchiveSweepQueue();
  worker = new TrackedWorker(
    ARCHIVE_SWEEP_QUEUE,
    async (job) => {
      await processArchiveSweepJob(job);
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Archive sweep failed"
    );
  });

  await queue.upsertJobScheduler(
    "archive-sweep-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "archive-sweep" }
  );
  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
      retentionDays: env.FILE_SERVICE_SHARE_RETENTION_DAYS,
    },
    "Archive sweep worker started"
  );
}

export async function stopArchiveSweep(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { processArchiveSweepTick };
