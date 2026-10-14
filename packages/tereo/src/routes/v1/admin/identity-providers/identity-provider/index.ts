import { requirePermission } from "../../../../../middleware/auth.js";
import { requireProvider } from "./middleware.js";
import domainsRouter from "./domains/index.js";
import { Router } from "express";
import {
  activateIdentityProvider,
  deactivateIdentityProvider,
  getIdentityProvider,
  updateIdentityProvider,
} from "./controllers.js";

const router = Router({ mergeParams: true });

// Reading is the floor for everything below; routes that change something
// ask for identity-providers.write on top.
router.use(requirePermission("identity-providers.read"));
router.use(requireProvider);

router.use("/domains", domainsRouter);

router.post(
  "/deactivate",
  requirePermission("identity-providers.write"),
  deactivateIdentityProvider
);
router.post(
  "/activate",
  requirePermission("identity-providers.write"),
  activateIdentityProvider
);

router.get("/", getIdentityProvider);
router.patch(
  "/",
  requirePermission("identity-providers.write"),
  updateIdentityProvider
);

export default router;
