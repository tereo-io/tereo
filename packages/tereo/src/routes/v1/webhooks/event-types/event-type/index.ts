import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const eventTypeRouter = Router({ mergeParams: true });

eventTypeRouter.get(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.EVENT_TYPES.READ),
  controllers.getEventType
);

export default eventTypeRouter;
