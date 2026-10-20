import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { transferBucketOwnership } from "./controllers.js";
import { Router } from "express";

const ownerRouter = Router({ mergeParams: true });

ownerRouter.put(
  "/",
  requirePermission(PERMISSIONS.admin),
  transferBucketOwnership
);

export default ownerRouter;
