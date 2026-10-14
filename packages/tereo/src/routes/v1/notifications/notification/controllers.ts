import { ForbiddenError, NotFoundError } from "../../../../utils/errors.js";
import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { validateParams } from "../../../../utils/validateReq.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { validateUser } from "../../../../middleware/auth.js";
import { NotificationIdParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";

const { SEND, READ } = PERMISSIONS.NOTIFICATIONS;

export const getNotification = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const canReadAll = hasPermission(auth.permissions, READ);
  if (!canReadAll && !hasPermission(auth.permissions, SEND)) {
    throw new ForbiddenError(
      `One of the following permissions is required: ${SEND}, ${READ}`
    );
  }
  const { id } = validateParams(NotificationIdParamsSchema, req);
  const notification = await db.notifications.getWithDeliveries(id);
  // A sender learns nothing of other senders' notifications, not even that
  // the id exists.
  if (
    !notification ||
    (!canReadAll && notification.senderUserId !== auth.userId)
  ) {
    throw new NotFoundError("Notification not found");
  }

  res.json({
    id: notification.id,
    channel: notification.channel,
    connectionId: notification.connectionId,
    senderUserId: notification.senderUserId,
    organizationId: notification.organizationId,
    status: notification.status,
    summary: notification.summary,
    recipients: notification.recipients,
    attachments: notification.attachments,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
    deliveries: notification.deliveries.map((d) => ({
      id: d.id,
      connectionId: d.connectionId,
      recipients: d.recipients,
      status: d.status,
      attempts: d.attempts,
      lastError: d.lastError,
      providerMessageId: d.providerMessageId,
      sentAt: d.sentAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
  });
};
