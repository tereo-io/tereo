import { validateBody } from "../../../utils/validateReq.js";
import { validateUser } from "../../../middleware/auth.js";
import { SendNotificationSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  validateNotification,
  writeNotification,
  type NotificationInput,
} from "../../../utils/notifications/accept.js";
import {
  NOTIFICATIONS_IDEMPOTENCY_PREFIX,
  withAuditIdempotency,
} from "../../../utils/auditIdempotency.js";

export const sendNotification = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { idempotencyKey, ...input } = validateBody(
    SendNotificationSchema,
    req
  );
  const sender = { userId: auth.userId, email: auth.email, auth };

  // Validation runs inside, so a replay answers the first result even after
  // what it checked (a connection, a user, a grant) has changed.
  const result = await withAuditIdempotency(
    {
      prefix: NOTIFICATIONS_IDEMPOTENCY_PREFIX,
      userId: auth.userId,
      route: "notifications",
      key: idempotencyKey,
      body: input,
    },
    async () => {
      const notification = await validateNotification(
        sender,
        input as NotificationInput
      );
      const { id } = await db.$transaction((tx) =>
        writeNotification(tx, sender, notification)
      );
      return { id, status: "pending" };
    }
  );
  res.status(202).json(result);
};
