import { PERMISSIONS } from "../../../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../../../middleware/auth.js";
import { presignObjectById } from "./controllers.js";
import { Router } from "express";

/**
 * Mounted at `/buckets/:name/objects/by-id/:id/presign` by the byId router.
 * Inherits `:name` (bucket) and `:id` via mergeParams.
 */
const presignRouter = Router({ mergeParams: true });

presignRouter.post(
  "/",
  requirePermission(PERMISSIONS.objects.read),
  presignObjectById
);

export default presignRouter;
