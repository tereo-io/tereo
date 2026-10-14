import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { listPermissions, grantPermission } from "./controllers.js";
import permissionRouter from "./permission/index.js";
import { Router } from "express";

const permissionsRouter = Router({ mergeParams: true });

permissionsRouter.use("/:userId", permissionRouter);

permissionsRouter.get(
  "/",
  requirePermission(PERMISSIONS.permissions.read),
  listPermissions
);
permissionsRouter.post(
  "/",
  requirePermission(PERMISSIONS.permissions.write),
  grantPermission
);

export default permissionsRouter;
