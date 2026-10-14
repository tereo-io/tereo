import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { createShare, listShares } from "./controllers.js";
import byIdRouter from "./by-id/index.js";
import { Router } from "express";

/**
 * Share management — authenticated CRUD. The public download side lives under
 * `/shared/:token` (`src/routes/shared/`) with no auth middleware.
 */
const sharesRouter = Router({ mergeParams: true });

sharesRouter.use("/by-id", byIdRouter);

sharesRouter.post(
  "/",
  requirePermission(PERMISSIONS.shares.write),
  createShare
);
sharesRouter.get("/", requirePermission(PERMISSIONS.shares.read), listShares);

export default sharesRouter;
