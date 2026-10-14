import { getShareSweepQueue, SHARE_SWEEP_QUEUE } from "./queues.js";
import { createTimeBoxedLoop, isShuttingDown } from "./jobUtils.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
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

export async function processShareSweepTick(): Promise<{
  processed: number;
  hasMore: boolean;
}> {
  await db.shares.backfillExpiry(env.FILE_SERVICE_MAX_SHARE_TTL_SECONDS);
  const graceMs = env.FILE_SERVICE_SHARE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const processed = await db.shares.deleteExpired(
    graceMs,
    new Date(),
    BATCH_LIMIT
  );
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
