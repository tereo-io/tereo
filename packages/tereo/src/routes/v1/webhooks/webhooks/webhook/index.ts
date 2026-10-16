import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { requireWebhookPermission } from "../middleware.js";
import { guardArchivedWebhook } from "./middleware.js";
import deliveriesRouter from "./deliveries/index.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const webhookRouter = Router({ mergeParams: true });

webhookRouter.use("/deliveries", deliveriesRouter);

webhookRouter.post(
  "/rotate-secret",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.ADMIN),
  guardArchivedWebhook,
  controllers.rotateSecret
);
webhookRouter.post(
  "/revoke-previous-secret",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.ADMIN),
  guardArchivedWebhook,
  controllers.revokePreviousSecret
);
webhookRouter.post(
  "/test",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.WRITE),
  guardArchivedWebhook,
  controllers.testWebhookEndpoint
);
webhookRouter.get(
  "/stats",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.getEndpointStats
);
webhookRouter.post(
  "/archive",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.ARCHIVE),
  controllers.archiveWebhookEndpoint
);
webhookRouter.post(
  "/restore",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.ARCHIVE),
  controllers.restoreWebhookEndpoint
);

webhookRouter.get(
  "/",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.getWebhookEndpoint
);
webhookRouter.patch(
  "/",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.WRITE),
  guardArchivedWebhook,
  controllers.updateWebhookEndpoint
);
webhookRouter.delete(
  "/",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.DELETE),
  controllers.deleteWebhookEndpoint
);

export default webhookRouter;
