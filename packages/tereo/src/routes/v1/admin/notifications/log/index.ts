import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import notificationRouter from "./notification/index.js";
import { listNotifications } from "./controllers.js";
import { Router } from "express";

const logRouter = Router();

logRouter.use("/:id", notificationRouter);

logRouter.get(
  "/",
  requirePermission(PERMISSIONS.NOTIFICATIONS.READ),
  listNotifications
);

export default logRouter;
