import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requireWebhookPermission } from "../../middleware.js";
import deliveryRouter from "./delivery/index.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const deliveriesRouter = Router({ mergeParams: true });

deliveriesRouter.post(
  "/retry",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.WRITE),
  controllers.bulkRetryDeliveries
);

deliveriesRouter.use("/:deliveryId", deliveryRouter);

deliveriesRouter.get(
  "/",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.listDeliveries
);

export default deliveriesRouter;
