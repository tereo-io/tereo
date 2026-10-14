import { PERMISSIONS } from "../../../../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../../../../middleware/auth.js";
import { Router } from "express";
import {
  deleteObjectVersionById,
  downloadObjectVersionById,
  getObjectVersionById,
  restoreObjectVersionById,
} from "./controllers.js";

/**
 * Mounted at `/versions/:versionId` by the versions router. Inherits `:name`
 * (bucket), `:id` (object), and `:versionId` via mergeParams.
 */
const versionRouter = Router({ mergeParams: true });

versionRouter.post(
  "/restore",
  requirePermission(PERMISSIONS.objects.write),
  restoreObjectVersionById
);
// `/download` must be declared BEFORE `/` so the literal segment isn't
// swallowed by the base version handler.
versionRouter.get("/download", downloadObjectVersionById);
versionRouter.get("/", getObjectVersionById);
versionRouter.delete(
  "/",
  requirePermission(PERMISSIONS.objects.delete),
  deleteObjectVersionById
);

export default versionRouter;
