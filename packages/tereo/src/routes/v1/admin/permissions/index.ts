import { requirePermission } from "../../../../middleware/auth.js";
import permissionRouter from "./permission/index.js";
import { listPermissions } from "./controllers.js";
import { Router } from "express";

// Read-only: permissions are declared in code, never made by admins.
const permissionsRouter = Router();

permissionsRouter.use("/:id", permissionRouter);

permissionsRouter.get(
  "/",
  requirePermission("permissions.read"),
  listPermissions
);

export default permissionsRouter;
