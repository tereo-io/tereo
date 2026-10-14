import type { NotificationChannel } from "../utils/notifications/channels/types.js";
import { CHANNELS } from "../utils/notifications/channels/index.js";
import type { DeliveryRef } from "../utils/db/notifications.js";
import { Queue } from "bullmq";
import {
  createQueue,
  REMOVAL_POLICIES,
  RETRY_POLICIES,
} from "../utils/bullmq.js";

/**
 * Tries in total: the first plus retries 1, 2, 4… minutes apart. Counted on
 * the delivery row too, so a job the stale sweep re-queues does not add more.
 */
export const NOTIFICATION_DELIVERY_ATTEMPTS = 8;

export const NOTIFICATION_DELIVERY_JOB_OPTIONS = {
  attempts: NOTIFICATION_DELIVERY_ATTEMPTS,
  backoff: { type: "exponential", delay: 60_000 },
  ...REMOVAL_POLICIES.TRANSIENT,
};

export interface NotificationDeliveryJobData {
  deliveryId: string;
  notificationId: string;
  /** The notification's `createdAt` (ISO 8601), the deliveries' partition key. */
  notificationCreatedAt: string;
  /** Times this job was delayed by a failure before it claimed the delivery. */
  preClaimDelays?: number;
}

export const notificationQueueName = (channel: NotificationChannel) =>
  `notifications-${channel}`;

const queues = new Map<NotificationChannel, Queue>();
let staleSweepQueue: Queue | null = null;

export function getNotificationQueue(channel: NotificationChannel): Queue {
  let queue = queues.get(channel);
  if (!queue) {
    queue = createQueue(notificationQueueName(channel));
    queues.set(channel, queue);
  }
  return queue;
}

const FINISHED_STATES = new Set(["completed", "failed", "unknown"]);

/**
 * Queue a delivery under its own id as the job id, so it has at most one live
 * job: adding while one is waiting, delayed or active is a no-op. A finished
 * job still kept for inspection is replaced, or a re-queued delivery would
 * never run again. Returns "added", "live" (waiting or delayed: it will run),
 * or "active": running now, so it may settle without seeing a requeue made
 * meanwhile, and the caller should try again once it has finished.
 */
export async function enqueueNotificationDelivery(
  channel: NotificationChannel,
  delivery: DeliveryRef & { notificationId: string }
): Promise<"added" | "live" | "active"> {
  const queue = getNotificationQueue(channel);
  const existing = await queue.getJob(delivery.id);
  if (existing) {
    const state = await existing.getState();
    if (state === "active") return "active";
    if (!FINISHED_STATES.has(state)) return "live";
    await existing.remove();
  }
  const data: NotificationDeliveryJobData = {
    deliveryId: delivery.id,
    notificationId: delivery.notificationId,
    notificationCreatedAt: delivery.notificationCreatedAt.toISOString(),
  };
  await queue.add("notification-delivery", data, {
    ...NOTIFICATION_DELIVERY_JOB_OPTIONS,
    jobId: delivery.id,
  });
  return "added";
}

export function getNotificationStaleSweepQueue(): Queue {
  if (!staleSweepQueue) {
    staleSweepQueue = createQueue("notifications-stale-sweep", {
      defaultJobOptions: {
        ...RETRY_POLICIES.ONESHOT,
        ...REMOVAL_POLICIES.MAINTENANCE,
      },
    });
  }
  return staleSweepQueue;
}

export async function closeNotificationQueues(): Promise<void> {
  for (const channel of CHANNELS) {
    await queues.get(channel)?.close();
    queues.delete(channel);
  }
  await staleSweepQueue?.close();
  staleSweepQueue = null;
}
