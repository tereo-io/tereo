import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import deliveryRouter from "./delivery/index.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const deliveriesRouter = Router({ mergeParams: true });

deliveriesRouter.post(
  "/retry",
  requirePermission(PERMISSIONS.WEBHOOKS.WRITE),
  controllers.bulkRetryDeliveries
);

deliveriesRouter.use("/:deliveryId", deliveryRouter);

deliveriesRouter.get(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.listDeliveries
);

export default deliveriesRouter;
