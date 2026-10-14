import { createTimeBoxedLoop, isShuttingDown } from "./jobUtils.js";
import { enqueueOrphanBlobCleanup } from "./orphanBlobCleanup.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import env from "../env.js";
import {
  getOrphanBlobBackstopQueue,
  ORPHAN_BLOB_BACKSTOP_QUEUE,
} from "./queues.js";

// Runs hourly. The primary orphan-cleanup path is the individual per-hash
// enqueue in decRef call sites — this backstop exists to recover orphans that
// missed that enqueue (Redis hiccup during commit, service crash after the
// blob row was marked orphaned but before the job was added, etc.).
const JOB_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 500;

let worker: Worker | null = null;

type BackstopCursor = { hash: string; orphanedAt: Date };

/**
 * One page of orphans past their grace, each given a cleanup job. `runId` is
 * the job-id suffix: an orphan's earlier job may have finished without
 * deleting it (failed, or found it locked) and its id is still retained, so
 * the backstop's jobs are its own — one per orphan per run.
 */
async function processOrphanBlobBackstopTick(
  runId: string,
  after?: BackstopCursor
): Promise<{
  processed: number;
  hasMore: boolean;
  cursor?: BackstopCursor;
}> {
  const graceSeconds = env.FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS;
  const rows = await db.contentBlobs.listOrphansPastGrace(
    graceSeconds,
    BATCH_LIMIT,
    after
  );

  let enqueued = 0;
  for (const { hash } of rows) {
    if (isShuttingDown()) break;
    try {
      await enqueueOrphanBlobCleanup(hash, { suffix: runId });
      enqueued++;
    } catch (err) {
      logger.warn(
        {
          hash,
          err,
        },
        "Orphan backstop enqueue failed"
      );
    }
  }

  return {
    processed: enqueued,
    hasMore: rows.length >= BATCH_LIMIT,
    cursor: rows.at(-1),
  };
}

/**
 * Test/helper entry point mirroring the pre-refactor API.
 */
async function processOrphanBlobBackstop(): Promise<void> {
  const res = await processOrphanBlobBackstopTick(`b${Date.now()}`);
  logger.info(
    {
      enqueued: res.processed,
    },
    "Orphan blob backstop completed"
  );
}

async function processOrphanBlobBackstopJob(job: Job): Promise<void> {
  if (isShuttingDown()) return;
  const runId = `b${Date.now()}`;
  const result = await createTimeBoxedLoop<BackstopCursor>({
    job,
    tick: async (cursor) => await processOrphanBlobBackstopTick(runId, cursor),
  });
  logger.info(
    {
      iterations: result.iterations,
      totalProcessed: result.totalProcessed,
      completed: result.completed,
    },
    "Orphan blob backstop completed"
  );
}

export async function startOrphanBlobBackstop(): Promise<void> {
  const queue = getOrphanBlobBackstopQueue();
  worker = new TrackedWorker(
    ORPHAN_BLOB_BACKSTOP_QUEUE,
    async (job) => {
      await processOrphanBlobBackstopJob(job);
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Orphan blob backstop failed"
    );
  });

  await queue.upsertJobScheduler(
    "orphan-blob-backstop-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "orphan-blob-backstop" }
  );
  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
    },
    "Orphan blob backstop worker started"
  );
}

export async function stopOrphanBlobBackstop(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { processOrphanBlobBackstop };
