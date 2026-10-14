import { requirePermission } from "../../../../middleware/auth.js";
import identityProviderRouter from "./identity-provider/index.js";
import { Router } from "express";
import {
  createIdentityProvider,
  listIdentityProviders,
} from "./controllers.js";

const identityProvidersRouter = Router();

identityProvidersRouter.use("/:id", identityProviderRouter);

identityProvidersRouter.get(
  "/",
  requirePermission("identity-providers.read"),
  listIdentityProviders
);
identityProvidersRouter.post(
  "/",
  requirePermission("identity-providers.write"),
  createIdentityProvider
);

export default identityProvidersRouter;
