import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { listChannels } from "./controllers.js";
import { Router } from "express";

const channelsRouter = Router();

channelsRouter.get(
  "/",
  requirePermission(PERMISSIONS.NOTIFICATIONS.READ),
  listChannels
);

export default channelsRouter;
