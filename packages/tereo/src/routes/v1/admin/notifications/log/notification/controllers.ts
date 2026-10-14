import { validateParams } from "../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { NotificationIdParamsSchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  ConflictError,
  NotFoundError,
} from "../../../../../../utils/errors.js";
import {
  enqueueNotificationTx,
  logAuditTx,
} from "../../../../../../utils/outbox.js";

export const getNotification = async (req: Request, res: Response) => {
  const { id } = validateParams(NotificationIdParamsSchema, req);
  const notification = await db.notifications.getWithDeliveries(id);
  if (!notification) throw new NotFoundError("Notification not found");
  const { deliveries, ...rest } = notification;
  res.json({
    ...rest,
    deliveries: deliveries.map(
      ({ notificationId: _n, notificationCreatedAt: _c, ...d }) => d
    ),
  });
};

export const retryNotification = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(NotificationIdParamsSchema, req);
  const notification = await db.notifications.get(id);
  if (!notification) throw new NotFoundError("Notification not found");

  const requeued = await db.$transaction(async (tx) => {
    const count = await db.notifications.requeueFailed(
      tx,
      notification.id,
      notification.createdAt
    );
    if (count === 0) return 0;
    await logAuditTx(tx, {
      auth,
      organizationId: notification.organizationId,
      action: "UPDATE",
      entityType: "Notification",
      entityId: notification.id,
      entityName: notification.channel,
      metadata: { retried: count },
    });
    await enqueueNotificationTx(tx, notification);
    return count;
  });
  if (requeued === 0) {
    throw new ConflictError(
      "The notification has no failed deliveries to retry",
      "nothing_to_retry"
    );
  }
  res.json({ requeued });
};
