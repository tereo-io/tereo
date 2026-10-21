import { startBackgroundJobs, stopBackgroundJobs } from "./jobs/index.js";
import { createOutboxReaper, type OutboxReaper } from "./utils/outbox.js";
import { dispatchNotification } from "./utils/notifications/dispatch.js";
import { closeNotificationQueues } from "./jobs/notificationQueues.js";
import { closeQueues as closeFileQueues } from "./jobs/queues.js";
import { dispatchOutboxEvent } from "./utils/processEvent.js";
import { closeWebhookQueues } from "./jobs/webhookQueues.js";
import { closeAuditQueues } from "./jobs/auditQueues.js";
import { logger } from "./utils/logger.js";
import env from "./env.js";
import {
  startNotificationStaleSweep,
  stopNotificationStaleSweep,
} from "./jobs/notificationStaleSweep.js";
import {
  startNotificationRetentionWorker,
  stopNotificationRetentionWorker,
} from "./jobs/notificationRetention.js";
import {
  startNotificationDeliveryWorker,
  stopNotificationDeliveryWorker,
} from "./jobs/notificationDelivery.js";
import {
  startStaleDeliverySweep,
  stopStaleDeliverySweep,
} from "./jobs/staleDeliverySweep.js";
import {
  startAccessLogRetentionWorker,
  stopAccessLogRetentionWorker,
} from "./jobs/accessLogRetention.js";
import {
  startDeliveryRetentionWorker,
  stopDeliveryRetentionWorker,
} from "./jobs/deliveryRetention.js";
import {
  startOutboxRetentionWorker,
  stopOutboxRetentionWorker,
} from "./jobs/outboxRetention.js";
import {
  startWebhookDeliveryWorker,
  stopWebhookDeliveryWorker,
} from "./jobs/webhookDelivery.js";
import {
  processEntryRetention,
  startEntryRetentionWorker,
  stopEntryRetentionWorker,
} from "./jobs/entryRetention.js";

// Background work: BullMQ workers and schedulers, and the outbox reaper. Runs
// in processes started with ROLE=worker or ROLE=all.

let reaper: OutboxReaper | null = null;

export async function startWorker(): Promise<void> {
  await startBackgroundJobs();

  // Webhook delivery, its stale-delivery sweep and partition maintenance stay
  // off under test; tests drive those paths directly.
  if (env.NODE_ENV !== "test") {
    await startWebhookDeliveryWorker();
    await startDeliveryRetentionWorker();
    await startStaleDeliverySweep();
    await processEntryRetention().catch((err) => {
      logger.warn({ err }, "Initial audit partition check failed");
    });
    await startEntryRetentionWorker();
    await startNotificationRetentionWorker();
    await startNotificationDeliveryWorker();
    await startNotificationStaleSweep();
    await startOutboxRetentionWorker();
    await startAccessLogRetentionWorker();
  }

  // Webhook events written by `emitTx` fan out to subscribed endpoints. The
  // fan-out records the outbox row id with the deliveries, so a retry after a
  // crash between fan-out and row delete doesn't create duplicate deliveries.
  reaper = createOutboxReaper({
    dispatchers: {
      webhook: (payload, row) =>
        dispatchOutboxEvent(payload, row.id, row.created_at),
      notification: (payload) => dispatchNotification(payload),
    },
  });
  reaper.start();
}

export async function stopWorker(): Promise<void> {
  await reaper?.stop();
  reaper = null;
  await stopBackgroundJobs();
  await stopWebhookDeliveryWorker();
  await stopDeliveryRetentionWorker();
  await stopStaleDeliverySweep();
  await stopEntryRetentionWorker();
  await stopNotificationRetentionWorker();
  await stopNotificationDeliveryWorker();
  await stopNotificationStaleSweep();
  await stopOutboxRetentionWorker();
  await stopAccessLogRetentionWorker();
}

/**
 * Closes the queues jobs are added to. Separate from `stopWorker`: in a
 * process that also serves HTTP, requests still draining add jobs to them.
 */
export async function closeWorkerQueues(): Promise<void> {
  await closeFileQueues();
  await closeWebhookQueues();
  await closeAuditQueues();
  await closeNotificationQueues();
}
