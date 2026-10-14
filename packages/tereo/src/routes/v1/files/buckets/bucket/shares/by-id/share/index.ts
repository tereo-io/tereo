import { PERMISSIONS } from "../../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../../middleware/auth.js";
import { getShare, revokeShare, updateShare } from "./controllers.js";
import { Router } from "express";

const shareRouter = Router({ mergeParams: true });

shareRouter.get("/", requirePermission(PERMISSIONS.shares.read), getShare);
shareRouter.patch(
  "/",
  requirePermission(PERMISSIONS.shares.write),
  updateShare
);
shareRouter.delete(
  "/",
  requirePermission(PERMISSIONS.shares.delete),
  revokeShare
);

export default shareRouter;
