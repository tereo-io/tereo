import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { Router } from "express";
import {
  deleteLifecyclePolicy,
  getLifecyclePolicy,
  upsertLifecyclePolicy,
} from "./controllers.js";

const lifecycleRouter = Router({ mergeParams: true });

lifecycleRouter.get(
  "/",
  requirePermission(PERMISSIONS.buckets.read),
  getLifecyclePolicy
);
lifecycleRouter.put(
  "/",
  requirePermission(PERMISSIONS.buckets.write),
  upsertLifecyclePolicy
);
lifecycleRouter.delete(
  "/",
  requirePermission(PERMISSIONS.buckets.delete),
  deleteLifecyclePolicy
);

export default lifecycleRouter;
