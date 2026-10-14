import { PERMISSIONS } from "../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../middleware/auth.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const deliveryRouter = Router({ mergeParams: true });

deliveryRouter.post(
  "/retry",
  requirePermission(PERMISSIONS.WEBHOOKS.WRITE),
  controllers.retryDelivery
);

deliveryRouter.get(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.getDelivery
);

export default deliveryRouter;
