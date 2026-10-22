import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { isShuttingDown } from "./jobUtils.js";
import { logger } from "../utils/logger.js";
import { Queue, Worker } from "bullmq";
import db from "../utils/db/index.js";
import env from "../env.js";
import {
  createQueue,
  REMOVAL_POLICIES,
  RETRY_POLICIES,
} from "../utils/bullmq.js";

const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Deletes `files.access_logs` rows older than `ACCESS_LOG_RETENTION_DAYS`, a
 * batch at a time so no one statement holds locks or bloats WAL for long.
 * Returns how many it deleted.
 */
export async function runAccessLogRetention(
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - env.ACCESS_LOG_RETENTION_DAYS * MS_PER_DAY
  );
  let deleted = 0;
  while (!isShuttingDown()) {
    const batch = await db.accessLogs.deleteBefore(cutoff, BATCH_SIZE);
    deleted += batch;
    if (batch < BATCH_SIZE) break;
  }
  logger.info(
    { deleted, cutoff: cutoff.toISOString() },
    "Access log retention job completed"
  );
  return deleted;
}

export async function startAccessLogRetentionWorker(): Promise<void> {
  worker = new TrackedWorker(
    "access-log-retention",
    async () => {
      await runAccessLogRetention();
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Access log retention job failed");
  });

  queue = createQueue("access-log-retention", {
    defaultJobOptions: {
      ...RETRY_POLICIES.ONESHOT,
      ...REMOVAL_POLICIES.MAINTENANCE,
    },
  });
  await queue.upsertJobScheduler(
    "access-log-retention-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "access-log-retention" }
  );

  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
      retentionDays: env.ACCESS_LOG_RETENTION_DAYS,
    },
    "Access log retention worker started"
  );
}

export async function stopAccessLogRetentionWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
