import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { requirePermission } from "../../../../middleware/auth.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const eventsRouter = Router();

eventsRouter.post(
  "/batch",
  requirePermission(PERMISSIONS.WEBHOOKS.EMIT),
  controllers.batchEmitEvents
);

eventsRouter.post(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.EMIT),
  controllers.emitEvent
);

export default eventsRouter;
