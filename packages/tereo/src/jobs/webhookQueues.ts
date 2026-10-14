import type { DeliveryRef } from "../utils/db/webhookDeliveries.js";
import { logger } from "../utils/logger.js";
import { Queue } from "bullmq";
import {
  createQueue,
  REMOVAL_POLICIES,
  RETRY_POLICIES,
} from "../utils/bullmq.js";

/**
 * Delivery tries in total: the first plus retries 5, 10, 20… minutes apart.
 * Counted on the delivery row, so a re-queued job does not add more.
 */
export const WEBHOOK_DELIVERY_ATTEMPTS = 10;

export const WEBHOOK_DELIVERY_JOB_OPTIONS = {
  attempts: WEBHOOK_DELIVERY_ATTEMPTS,
  backoff: { type: "exponential", delay: 300_000 },
  removeOnComplete: 500,
  removeOnFail: 500,
};

/** `previousAttempts`: the delivery's `attempts` before this one. */
export const isLastDeliveryAttempt = (previousAttempts: number): boolean =>
  previousAttempts >= WEBHOOK_DELIVERY_ATTEMPTS - 1;

let webhookDeliveryQueue: Queue | null = null;
let deliveryRetentionQueue: Queue | null = null;
let staleDeliveryQueue: Queue | null = null;

export function getWebhookDeliveryQueue(): Queue {
  if (!webhookDeliveryQueue) {
    webhookDeliveryQueue = createQueue("webhooks-delivery", {
      defaultJobOptions: {
        ...RETRY_POLICIES.TRANSIENT,
        ...REMOVAL_POLICIES.TRANSIENT,
      },
    });
  }
  return webhookDeliveryQueue;
}

const FINISHED_STATES = new Set(["completed", "failed", "unknown"]);

export interface WebhookDeliveryJobData {
  deliveryId: string;
  /** The delivery's `createdAt` (ISO 8601), its partition key; absent on older jobs. */
  createdAt?: string;
}

/**
 * Queue a delivery under its own id as the job id, so a delivery has at most
 * one live job: adding while one is waiting, delayed or active is a no-op.
 * A finished job still kept for inspection is replaced, or a retried or
 * re-queued delivery would never run again. Returns whether a job was added.
 */
export async function enqueueWebhookDelivery(
  delivery: DeliveryRef
): Promise<boolean> {
  const queue = getWebhookDeliveryQueue();
  const existing = await queue.getJob(delivery.id);
  if (existing) {
    const state = await existing.getState();
    if (!FINISHED_STATES.has(state)) return false;
    await existing.remove();
  }
  const data: WebhookDeliveryJobData = {
    deliveryId: delivery.id,
    createdAt: delivery.createdAt?.toISOString(),
  };
  await queue.add("webhook-delivery", data, {
    ...WEBHOOK_DELIVERY_JOB_OPTIONS,
    jobId: delivery.id,
  });
  return true;
}

/**
 * Queue a delivery whose row has committed. A failure is logged, not thrown:
 * failing the request would invite a retry that writes the delivery again,
 * and the stale-delivery sweep queues it later.
 */
export async function enqueueCommittedDelivery(
  delivery: DeliveryRef
): Promise<void> {
  await enqueueWebhookDelivery(delivery).catch((err) => {
    logger.error(
      {
        deliveryId: delivery.id,
        err,
      },
      "Failed to enqueue committed webhook delivery"
    );
  });
}

export function getDeliveryRetentionQueue(): Queue {
  if (!deliveryRetentionQueue) {
    deliveryRetentionQueue = createQueue("webhooks-delivery-retention", {
      defaultJobOptions: {
        ...RETRY_POLICIES.ONESHOT,
        ...REMOVAL_POLICIES.MAINTENANCE,
      },
    });
  }
  return deliveryRetentionQueue;
}

export function getStaleDeliveryQueue(): Queue {
  if (!staleDeliveryQueue) {
    staleDeliveryQueue = createQueue("webhooks-stale-delivery-sweep", {
      defaultJobOptions: {
        ...RETRY_POLICIES.ONESHOT,
        ...REMOVAL_POLICIES.MAINTENANCE,
      },
    });
  }
  return staleDeliveryQueue;
}

export async function closeWebhookQueues(): Promise<void> {
  if (webhookDeliveryQueue) {
    await webhookDeliveryQueue.close();
    webhookDeliveryQueue = null;
  }
  if (deliveryRetentionQueue) {
    await deliveryRetentionQueue.close();
    deliveryRetentionQueue = null;
  }
  if (staleDeliveryQueue) {
    await staleDeliveryQueue.close();
    staleDeliveryQueue = null;
  }
}
