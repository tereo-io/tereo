import { enqueueNotificationDelivery } from "../../jobs/notificationQueues.js";
import { PermanentDispatchError } from "../outbox.js";
import { logger } from "../logger.js";
import db from "../db/index.js";
import { z } from "zod";

const payloadSchema = z.object({
  notificationId: z.guid(),
  createdAt: z.iso.datetime(),
});

/**
 * The outbox reaper's `notification` dispatcher: queue each pending delivery
 * of an accepted notification on its channel's queue. The job id is the
 * delivery id, so dispatching the same row again queues nothing new.
 */
export async function dispatchNotification(payload: unknown): Promise<void> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PermanentDispatchError("Malformed notification outbox payload");
  }
  const createdAt = new Date(parsed.data.createdAt);
  const notification = await db.notifications.get(
    parsed.data.notificationId,
    createdAt
  );
  // Gone with its partition: nothing left to send.
  if (!notification) {
    logger.warn(
      { notificationId: parsed.data.notificationId },
      "Notification to dispatch no longer exists"
    );
    return;
  }
  let active = 0;
  for (const delivery of await db.notifications.pendingDeliveries(
    notification.id,
    notification.createdAt
  )) {
    const queued = await enqueueNotificationDelivery(
      notification.channel,
      delivery
    );
    if (queued === "active") active++;
  }
  // A pending delivery whose job is still running was requeued (a retry)
  // while that job finished its last attempt: it would be left with no job
  // until the stale sweep. Fail the row so the reaper dispatches it again
  // shortly, once the job has finished.
  if (active > 0) {
    throw new Error(
      `${active} pending ${active === 1 ? "delivery has" : "deliveries have"} a job still running; dispatching again`
    );
  }
}
