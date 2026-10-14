import { requirePermission } from "../../../../middleware/auth.js";
import organizationRouter from "./organization/index.js";
import { Router } from "express";
import {
  createOrganization,
  getDefaultOrganization,
  listOrganizations,
} from "./controllers.js";

const organizationsRouter = Router();

// Specific lookup routes must be registered before the catch-all /:id mount.
organizationsRouter.get(
  "/default",
  requirePermission("organizations.read"),
  getDefaultOrganization
);

organizationsRouter.use("/:id", organizationRouter);

organizationsRouter.get(
  "/",
  requirePermission("organizations.read"),
  listOrganizations
);
organizationsRouter.post(
  "/",
  requirePermission("organizations.write"),
  createOrganization
);

export default organizationsRouter;
