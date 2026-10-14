import { PERMISSIONS } from "../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../middleware/auth.js";
import { revokePermission } from "./controllers.js";
import { Router } from "express";

const permissionRouter = Router({ mergeParams: true });

permissionRouter.delete(
  "/",
  requirePermission(PERMISSIONS.permissions.delete),
  revokePermission
);

export default permissionRouter;
