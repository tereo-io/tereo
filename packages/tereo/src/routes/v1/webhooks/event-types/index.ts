import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { requirePermission } from "../../../../middleware/auth.js";
import eventTypeRouter from "./event-type/index.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

// Read-only: event types are declared by their services and registered at
// boot (utils/registry.ts).
const eventTypesRouter = Router();

eventTypesRouter.use("/:eventType", eventTypeRouter);

eventTypesRouter.get(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.EVENT_TYPES.READ),
  controllers.listEventTypes
);

export default eventTypesRouter;
