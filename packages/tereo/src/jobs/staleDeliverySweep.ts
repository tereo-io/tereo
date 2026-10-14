import type { DeliveryCursor } from "../utils/db/webhookDeliveries.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { isShuttingDown } from "./jobUtils.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Worker } from "bullmq";
import env from "../env.js";
import {
  enqueueWebhookDelivery,
  getStaleDeliveryQueue,
  WEBHOOK_DELIVERY_JOB_OPTIONS,
} from "./webhookQueues.js";

// A delivery is written in the database and queued in Redis after the commit;
// one written while Redis was down was never queued and would stay PENDING.
// This sweep queues a PENDING delivery that was never attempted and has been
// untouched for longer than WEBHOOK_STALE_DELIVERY_SECONDS. One that has been
// attempted had a job, which is waiting out its backoff; it is looked at only
// once its last attempt is older than any backoff, in case Redis lost the job.
// A delivery that does have a live job is left alone either way: the job id is
// the delivery id.

const JOB_INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 500;

/** The longest wait between two attempts: the backoff before the last one. */
export const LONGEST_BACKOFF_MS =
  WEBHOOK_DELIVERY_JOB_OPTIONS.backoff.delay *
  2 ** (WEBHOOK_DELIVERY_JOB_OPTIONS.attempts - 2);
/**
 * An attempted delivery idle this long has lost its job: the longest backoff
 * (21h20m) plus margin for the attempt itself and a busy queue.
 */
export const ATTEMPTED_STALE_MS = 24 * 60 * 60 * 1000;

let worker: Worker | null = null;

export async function processStaleDeliveries(
  options: { now?: Date; staleAfterMs?: number; attemptedStaleMs?: number } = {}
): Promise<string[]> {
  const now = options.now ?? new Date();
  const staleAfterMs =
    options.staleAfterMs ?? env.WEBHOOK_STALE_DELIVERY_SECONDS * 1000;

  const updatedBefore = new Date(now.getTime() - staleAfterMs);
  const attemptedBefore = new Date(
    now.getTime() - (options.attemptedStaleMs ?? ATTEMPTED_STALE_MS)
  );

  const requeued: string[] = [];
  let candidates = 0;
  let after: DeliveryCursor | undefined;
  while (!isShuttingDown()) {
    const page = await db.webhookDeliveries.findStalePending({
      updatedBefore,
      attemptedBefore,
      after,
      limit: BATCH_SIZE,
    });
    candidates += page.length;
    for (const delivery of page) {
      if (await enqueueWebhookDelivery(delivery)) requeued.push(delivery.id);
    }
    if (page.length < BATCH_SIZE) break;
    after = page[page.length - 1];
  }

  if (requeued.length > 0) {
    logger.warn(
      { requeued: requeued.length, candidates },
      "Re-queued stale pending webhook deliveries"
    );
  }
  return requeued;
}

export async function startStaleDeliverySweep(): Promise<void> {
  worker = new TrackedWorker(
    "webhooks-stale-delivery-sweep",
    async () => {
      await processStaleDeliveries();
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Stale delivery sweep failed");
  });

  await getStaleDeliveryQueue().upsertJobScheduler(
    "stale-delivery-sweep-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "stale-delivery-sweep" }
  );

  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
      staleAfterSeconds: env.WEBHOOK_STALE_DELIVERY_SECONDS,
    },
    "Stale delivery sweep started"
  );
}

export async function stopStaleDeliverySweep(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
