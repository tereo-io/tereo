import { apiBodyParsers } from "../../../middleware/bodyParsers.js";
import { PERMISSIONS } from "../../../definitions/permissions.js";
import notificationRouter from "./notification/index.js";
import { sendNotification } from "./controllers.js";
import { Router } from "express";
import {
  rateLimitGeneral,
  rateLimitPreAuth,
} from "../../../middleware/rateLimit.js";
import {
  createRequireAuth,
  requirePermission,
} from "../../../middleware/auth.js";

const notificationsRouter = Router();

notificationsRouter.use(rateLimitPreAuth);
notificationsRouter.use(createRequireAuth({ area: "notifications" }));
notificationsRouter.use(rateLimitGeneral);
// Content is inline; attachments are references to stored objects.
notificationsRouter.use(...apiBodyParsers("10mb"));

notificationsRouter.use("/:id", notificationRouter);

notificationsRouter.post(
  "/",
  requirePermission(PERMISSIONS.NOTIFICATIONS.SEND),
  sendNotification
);

export default notificationsRouter;
