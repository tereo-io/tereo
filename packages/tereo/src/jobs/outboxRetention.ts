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
const BATCH_SIZE = 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;

/** Runs `deleteBatch` until a batch comes back short. Returns the total. */
const drain = async (
  deleteBatch: (limit: number) => Promise<number>
): Promise<number> => {
  let total = 0;
  while (!isShuttingDown()) {
    const deleted = await deleteBatch(BATCH_SIZE);
    total += deleted;
    if (deleted < BATCH_SIZE) break;
  }
  return total;
};

/**
 * Deletes outbox rows dead-lettered more than
 * `OUTBOX_DEAD_LETTER_RETENTION_DAYS` ago: until then `npm run cli --
 * outbox-replay` can return them to the reaper. Then deletes the
 * `webhooks.outbox_fanouts` records older than that whose outbox row is gone:
 * no replay can bring it back to be fanned out again.
 */
export async function runOutboxRetention(
  now: Date = new Date()
): Promise<{ deadLetters: number; fanouts: number }> {
  const cutoff = new Date(
    now.getTime() - env.OUTBOX_DEAD_LETTER_RETENTION_DAYS * MS_PER_DAY
  );
  const deadLetters = await drain((limit) =>
    db.outbox.deleteDeadLettersBefore(cutoff, limit)
  );
  const fanouts = await drain((limit) =>
    db.outboxFanouts.deleteBefore(cutoff, limit)
  );
  logger.info(
    { deadLetters, fanouts, cutoff: cutoff.toISOString() },
    "Outbox retention job completed"
  );
  return { deadLetters, fanouts };
}

export async function startOutboxRetentionWorker(): Promise<void> {
  worker = new TrackedWorker(
    "outbox-retention",
    async () => {
      await runOutboxRetention();
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Outbox retention job failed");
  });

  queue = createQueue("outbox-retention", {
    defaultJobOptions: {
      ...RETRY_POLICIES.ONESHOT,
      ...REMOVAL_POLICIES.MAINTENANCE,
    },
  });
  await queue.upsertJobScheduler(
    "outbox-retention-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "outbox-retention" }
  );

  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
      retentionDays: env.OUTBOX_DEAD_LETTER_RETENTION_DAYS,
    },
    "Outbox retention worker started"
  );
}

export async function stopOutboxRetentionWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
