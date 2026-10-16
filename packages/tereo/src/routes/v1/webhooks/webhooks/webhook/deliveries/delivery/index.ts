import { PERMISSIONS } from "../../../../../../../definitions/permissions.js";
import { requireWebhookPermission } from "../../../middleware.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const deliveryRouter = Router({ mergeParams: true });

deliveryRouter.post(
  "/retry",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.WRITE),
  controllers.retryDelivery
);

deliveryRouter.get(
  "/",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.getDelivery
);

export default deliveryRouter;
