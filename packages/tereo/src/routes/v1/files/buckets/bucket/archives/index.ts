import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { createArchive } from "./controllers.js";
import { Router } from "express";

/**
 * Archive-request creation. The download itself is served by the signature-
 * verified `/signed/archives/:id` route (no auth), so this is the only
 * authenticated entrypoint and it requires the same `read` system permission
 * that single-object downloads do.
 */
const archivesRouter = Router({ mergeParams: true });

archivesRouter.post(
  "/",
  requirePermission(PERMISSIONS.objects.read),
  createArchive
);

export default archivesRouter;
