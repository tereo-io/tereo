import { ARCHIVE_SWEEP_QUEUE, getArchiveSweepQueue } from "./queues.js";
import { createTimeBoxedLoop, isShuttingDown } from "./jobUtils.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import env from "../env.js";

// Daily, on the share sweep's grace: an archive is kept as long as a share
// pointing at it would be, so a share listing still shows its archive.
const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 500;

let worker: Worker | null = null;

async function processArchiveSweepTick(now: Date = new Date()): Promise<{
  processed: number;
  hasMore: boolean;
}> {
  const graceMs = env.FILE_SERVICE_SHARE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const processed = await db.archives.deleteExpired(graceMs, now, BATCH_LIMIT);
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
