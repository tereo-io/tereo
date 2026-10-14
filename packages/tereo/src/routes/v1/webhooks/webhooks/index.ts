import { resolveWebhookOrganizationId } from "../../../../middleware/organizationId.js";
import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { requirePermission } from "../../../../middleware/auth.js";
import * as controllers from "./controllers.js";
import webhookRouter from "./webhook/index.js";
import { Router } from "express";

const webhooksRouter = Router();

webhooksRouter.use(resolveWebhookOrganizationId);

webhooksRouter.use("/:id", webhookRouter);

webhooksRouter.get(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.READ),
  controllers.listWebhookEndpoints
);
webhooksRouter.post(
  "/",
  requirePermission(PERMISSIONS.WEBHOOKS.WRITE),
  controllers.createWebhookEndpoint
);

export default webhooksRouter;
