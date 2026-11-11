import { getMultipartSweepQueue, MULTIPART_SWEEP_QUEUE } from "./queues.js";
import { bucketEventScope, emitTx, logAuditTx } from "../utils/outbox.js";
import { createTimeBoxedLoop, isShuttingDown } from "./jobUtils.js";
import { sweepStaleScratchFiles } from "../utils/scratchFiles.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { blobStore } from "../utils/blobStore/index.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import env from "../env.js";

const JOB_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BATCH_LIMIT = 100;
const HOUR_MS = 60 * 60 * 1000;

let worker: Worker | null = null;

async function processMultipartSweepTick(): Promise<{
  processed: number;
  hasMore: boolean;
}> {
  // Stage 1: TTL-expired-but-still-active uploads — abort them and drop their
  // staged data. Mark aborted FIRST so any in-flight part PUTs start failing
  // `getActive`, then remove the dir + part rows.
  const expired = await db.multipartUploads.listExpired(BATCH_LIMIT);
  for (const upload of expired) {
    if (isShuttingDown()) break;
    try {
      const aborted = await db.$transaction(async (tx) => {
        if (!(await db.multipartUploads.markAborted(upload.id, tx))) {
          return false;
        }

        await logAuditTx(tx, {
          auth: { userId: SYSTEM_USER_ID, email: null },
          organizationId: upload.bucket.organizationId ?? undefined,
          action: "DELETE",
          entityType: "multipartUpload",
          entityId: upload.id,
          entityName: upload.objectKey,
          metadata: {
            bucketName: upload.bucket.name,
            objectKey: upload.objectKey,
            reason: "expired",
          },
        });

        await emitTx(tx, {
          eventType: "file-service.multipart.aborted",
          ...bucketEventScope(upload.bucket),
          entityType: "multipartUpload",
          entityId: upload.id,
          data: {
            bucketName: upload.bucket.name,
            objectKey: upload.objectKey,
            reason: "expired",
          },
        });
        return true;
      });
      // Finalized by a concurrent complete or abort, which cleans up itself.
      if (!aborted) continue;
      await blobStore.removeUpload(upload.id);
      await db.multipartUploads.deleteParts(upload.id);
    } catch (err) {
      logger.warn(
        {
          uploadId: upload.id,
          err,
        },
        "Failed to abort expired multipart upload"
      );
    }
  }

  // Stage 2: finalised uploads (aborted OR completed) whose inline cleanup
  // failed or never ran (process crashed between markAborted/markCompleted
  // and removeUpload). Re-run the cleanup so leaked staging files
  // don't accumulate. The `parts: { some: {} }` filter inside
  // `listFinalisedNeedingCleanup` keeps this bounded — once part rows are
  // removed the upload is skipped on subsequent ticks.
  const orphaned = await db.multipartUploads.listFinalisedNeedingCleanup(
    env.FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS,
    BATCH_LIMIT
  );
  for (const upload of orphaned) {
    if (isShuttingDown()) break;
    try {
      await blobStore.removeUpload(upload.id);
      await db.multipartUploads.deleteParts(upload.id);
    } catch (err) {
      logger.warn(
        {
          uploadId: upload.id,
          err,
        },
        "Failed to clean orphaned multipart upload"
      );
    }
  }

  const processed = expired.length + orphaned.length;
  return {
    processed,
    hasMore: expired.length >= BATCH_LIMIT || orphaned.length >= BATCH_LIMIT,
  };
}

/**
 * Delete the scratch files — staged uploads and multer's spool files, each
 * the scratch of one request — that a crash left behind: those past a day or
 * the multipart TTL, whichever is longer, far past any request still writing
 * one. Multipart parts are the blob store's, removed with their upload above.
 */
async function sweepTempFiles(now = Date.now()): Promise<number> {
  const maxAgeMs = Math.max(
    24 * HOUR_MS,
    env.FILE_SERVICE_MULTIPART_UPLOAD_TTL_HOURS * HOUR_MS
  );
  return await sweepStaleScratchFiles(maxAgeMs, now);
}

async function processMultipartSweepJob(job: Job): Promise<void> {
  if (isShuttingDown()) return;
  try {
    const removed = await sweepTempFiles();
    if (removed > 0) logger.info({ removed }, "Removed stale temp files");
  } catch (err) {
    logger.warn({ err }, "Temp file sweep failed");
  }
  const result = await createTimeBoxedLoop<null>({
    job,
    tick: async () => {
      const { processed, hasMore } = await processMultipartSweepTick();
      return { hasMore, processed };
    },
  });
  logger.info(
    {
      iterations: result.iterations,
      totalProcessed: result.totalProcessed,
      completed: result.completed,
    },
    "Multipart sweep completed"
  );
}

export async function startMultipartSweep(): Promise<void> {
  const queue = getMultipartSweepQueue();
  worker = new TrackedWorker(
    MULTIPART_SWEEP_QUEUE,
    async (job) => {
      await processMultipartSweepJob(job);
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Multipart sweep failed"
    );
  });

  await queue.upsertJobScheduler(
    "multipart-sweep-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "multipart-sweep" }
  );
  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
    },
    "Multipart sweep worker started"
  );
}

export async function stopMultipartSweep(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { processMultipartSweepTick, sweepTempFiles };
