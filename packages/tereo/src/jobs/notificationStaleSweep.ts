import type { DeliveryRef } from "../utils/db/notifications.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Worker } from "bullmq";
import {
  enqueueNotificationDelivery,
  getNotificationStaleSweepQueue,
} from "./notificationQueues.js";

// A delivery stays `sending` only while a worker sends it; the SMTP deadline
// (`smtpTimeouts.totalMs`) bounds that to 10 minutes. One `sending` for longer lost its worker
// mid-send, so it is put back to `pending` and queued again. It may have gone
// out already: SMTP offers no way to ask.

const JOB_INTERVAL_MS = 5 * 60_000;
export const STALE_SENDING_MS = 15 * 60_000;
/** Notification retention; older partitions are gone. */
const LOOKBACK_MS = 30 * 24 * 60 * 60_000;

let worker: Worker | null = null;

// A delivery `pending` with no live job lost it (an enqueue that failed after
// a retry's commit, a job removed by hand); it is queued again. One waiting on
// backoff has a delayed job, and queueing it is a no-op, so only deliveries
// pending longer than the longest backoff (64 minutes before the 8th attempt)
// are looked at. Some with live jobs still are (a rate-limited or queued-up
// backlog), so every page is read: a lost one may sit behind them.
export const STRANDED_PENDING_MS = 2 * 60 * 60_000;
export const STRANDED_PENDING_PAGE = 500;

/** Queue `ref` again; false when it is gone or already has a live job. */
const requeue = async (ref: DeliveryRef): Promise<boolean> => {
  const delivery = await db.notifications.getDelivery(ref);
  const notification =
    delivery &&
    (await db.notifications.get(
      delivery.notificationId,
      ref.notificationCreatedAt
    ));
  if (!notification) return false;
  return (
    (await enqueueNotificationDelivery(notification.channel, {
      ...ref,
      notificationId: notification.id,
    })) === "added"
  );
};

/** Returns the ids of the deliveries it queued. */
export async function processStaleNotificationDeliveries(
  now: Date = new Date()
): Promise<string[]> {
  const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);
  const createdAfter = new Date(now.getTime() - LOOKBACK_MS);

  const reset = await db.notifications.resetStaleSending(
    staleBefore,
    createdAfter
  );
  const resent: string[] = [];
  for (const ref of reset) {
    if (await requeue(ref)) resent.push(ref.id);
  }
  if (resent.length > 0) {
    logger.warn(
      { requeued: resent.length },
      "Re-queued notification deliveries left sending"
    );
  }

  const stranded: string[] = [];
  const pendingBefore = new Date(now.getTime() - STRANDED_PENDING_MS);
  let after: { updatedAt: Date; id: string } | undefined;
  for (;;) {
    const page = await db.notifications.stalePending(
      pendingBefore,
      createdAfter,
      STRANDED_PENDING_PAGE,
      after
    );
    for (const ref of page) {
      if (await requeue(ref)) stranded.push(ref.id);
    }
    if (page.length < STRANDED_PENDING_PAGE) break;
    after = page.at(-1);
  }
  if (stranded.length > 0) {
    logger.warn(
      { requeued: stranded.length },
      "Re-queued pending notification deliveries with no job"
    );
  }
  return [...resent, ...stranded];
}

export async function startNotificationStaleSweep(): Promise<void> {
  worker = new TrackedWorker(
    "notifications-stale-sweep",
    async () => {
      await processStaleNotificationDeliveries();
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );
  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, err },
      "Notification stale-sending sweep failed"
    );
  });
  await getNotificationStaleSweepQueue().upsertJobScheduler(
    "notification-stale-sweep-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "notification-stale-sweep" }
  );
  logger.info(
    { intervalMs: JOB_INTERVAL_MS, staleAfterMs: STALE_SENDING_MS },
    "Notification stale-sending sweep started"
  );
}

export async function stopNotificationStaleSweep(): Promise<void> {
  await worker?.close();
  worker = null;
}
