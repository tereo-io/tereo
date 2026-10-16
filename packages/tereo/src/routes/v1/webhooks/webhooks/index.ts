import { PERMISSIONS } from "../../../../definitions/permissions.js";
import * as controllers from "./controllers.js";
import webhookRouter from "./webhook/index.js";
import { Router } from "express";
import {
  requireWebhookPermission,
  resolveWebhookCaller,
} from "./middleware.js";

const webhooksRouter = Router();

webhooksRouter.use(resolveWebhookCaller);

webhooksRouter.use("/:id", webhookRouter);

webhooksRouter.get(
  "/",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.listWebhookEndpoints
);
webhooksRouter.post(
  "/",
  requireWebhookPermission(PERMISSIONS.WEBHOOKS.WRITE),
  controllers.createWebhookEndpoint
);

export default webhooksRouter;
