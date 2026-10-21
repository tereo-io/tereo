import { getMultipartSweepQueue, MULTIPART_SWEEP_QUEUE } from "./queues.js";
import { bucketEventScope, emitTx, logAuditTx } from "../utils/outbox.js";
import { createTimeBoxedLoop, isShuttingDown } from "./jobUtils.js";
import { removeMultipartDir } from "../utils/storage.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import fs from "fs/promises";
import env from "../env.js";
import path from "path";

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
      await removeMultipartDir(upload.id);
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
  // and removeMultipartDir). Re-run the cleanup so leaked staging files
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
      await removeMultipartDir(upload.id);
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
 * Delete files in `FILE_SERVICE_TEMP_PATH` — staged uploads and multer's
 * spool files, each the scratch of one request — that a crash left behind.
 * Only top-level files, by mtime, past a day or the multipart TTL, whichever
 * is longer: far past any request still writing one. Multipart parts live
 * under `{storage}/multipart`, swept with their upload above.
 */
/** Temp files core writes: staged uploads, signed uploads, multipart completes. */
const CORE_TEMP_FILE = /^(upload|signed-upload|mp-complete)-[0-9a-f]+$/;

async function sweepTempFiles(now = Date.now()): Promise<number> {
  const root = env.FILE_SERVICE_TEMP_PATH;
  const maxAgeMs = Math.max(
    24 * HOUR_MS,
    env.FILE_SERVICE_MULTIPART_UPLOAD_TTL_HOURS * HOUR_MS
  );
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let removed = 0;
  for (const entry of entries) {
    if (isShuttingDown()) break;
    // Only names core writes: the directory may be shared (`/tmp`).
    if (!entry.isFile() || !CORE_TEMP_FILE.test(entry.name)) continue;
    const p = path.join(root, entry.name);
    try {
      const { mtimeMs } = await fs.stat(p);
      if (now - mtimeMs < maxAgeMs) continue;
      await fs.unlink(p);
      removed++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      logger.warn({ err, path: p }, "Failed to remove stale temp file");
    }
  }
  return removed;
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
