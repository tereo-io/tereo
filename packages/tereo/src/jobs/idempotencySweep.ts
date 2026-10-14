import { getIdempotencySweepQueue, IDEMPOTENCY_SWEEP_QUEUE } from "./queues.js";
import { createTimeBoxedLoop, isShuttingDown } from "./jobUtils.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";

const JOB_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BATCH_LIMIT = 500;

let worker: Worker | null = null;

async function processIdempotencySweepTick(): Promise<{
  processed: number;
  hasMore: boolean;
}> {
  const processed = await db.idempotencyRecords.sweepExpired(BATCH_LIMIT);
  return {
    processed,
    hasMore: processed >= BATCH_LIMIT,
  };
}

async function processIdempotencySweepJob(job: Job): Promise<void> {
  if (isShuttingDown()) return;
  const result = await createTimeBoxedLoop<null>({
    job,
    tick: async () => {
      const { processed, hasMore } = await processIdempotencySweepTick();
      return { hasMore, processed };
    },
  });
  logger.info(
    {
      iterations: result.iterations,
      totalProcessed: result.totalProcessed,
      completed: result.completed,
    },
    "Idempotency sweep completed"
  );
}

export async function startIdempotencySweep(): Promise<void> {
  const queue = getIdempotencySweepQueue();
  worker = new TrackedWorker(
    IDEMPOTENCY_SWEEP_QUEUE,
    async (job) => {
      await processIdempotencySweepJob(job);
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Idempotency sweep failed"
    );
  });

  await queue.upsertJobScheduler(
    "idempotency-sweep-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "idempotency-sweep" }
  );
  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
    },
    "Idempotency sweep worker started"
  );
}

export async function stopIdempotencySweep(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
