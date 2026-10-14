import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { guardArchivedWebhook } from "./middleware.js";
import deliveriesRouter from "./deliveries/index.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const webhookRouter = Router({ mergeParams: true });

webhookRouter.use("/deliveries", deliveriesRouter);

webhookRouter.post(
  "/rotate-secret",
  requirePermission(PERMISSIONS.WEBHOOKS.ADMIN),
  guardArchivedWebhook,
  controllers.rotateSecret
);
webhookRouter.post(
  "/revoke-previous-secret",
  requirePermission(PERMISSIONS.WEBHOOKS.ADMIN),
  guardArchivedWebhook,
  controllers.revokePreviousSecret
);
webhookRouter.post(
  "/test",
  requirePermission(PERMISSIONS.WEBHOOKS.WRITE),
  guardArchivedWebhook,
  controllers.testWebhookEndpoint
);
webhookRouter.get(
  "/stats",
  requirePermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.getEndpointStats
);
webhookRouter.post(
  "/archive",
  requirePermission(PERMISSIONS.WEBHOOKS.ARCHIVE),
  controllers.archiveWebhookEndpoint
);
webhookRouter.post(
  "/restore",
  requirePermission(PERMISSIONS.WEBHOOKS.ARCHIVE),
  controllers.restoreWebhookEndpoint
);

webhookRouter.get(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.getWebhookEndpoint
);
webhookRouter.patch(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.WRITE),
  guardArchivedWebhook,
  controllers.updateWebhookEndpoint
);
webhookRouter.delete(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.DELETE),
  controllers.deleteWebhookEndpoint
);

export default webhookRouter;
