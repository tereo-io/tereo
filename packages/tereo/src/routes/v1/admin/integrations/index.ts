import { createIntegration, listIntegrations } from "./controllers.js";
import { requirePermission } from "../../../../middleware/auth.js";
import integrationRouter from "./integration/index.js";
import { Router } from "express";

const integrationsRouter = Router();

integrationsRouter.use("/:id", integrationRouter);

integrationsRouter.get(
  "/",
  requirePermission("integrations.read"),
  listIntegrations
);
integrationsRouter.post(
  "/",
  requirePermission("integrations.write"),
  createIntegration
);

export default integrationsRouter;
