import { bucketRateLimit } from "../../../../../middleware/bucketRateLimit.js";
import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { bucketCors } from "../../../../../middleware/bucketCors.js";
import permissionsRouter from "./permissions/index.js";
import lifecycleRouter from "./lifecycle/index.js";
import multipartRouter from "./multipart/index.js";
import archivesRouter from "./archives/index.js";
import objectsRouter from "./objects/index.js";
import sharesRouter from "./shares/index.js";
import ownerRouter from "./owner/index.js";
import { Router } from "express";
import {
  getBucket,
  updateBucket,
  deleteBucket,
  getMyPermissions,
} from "./controllers.js";

const bucketRouter = Router({ mergeParams: true });

bucketRouter.use("/objects", objectsRouter);
bucketRouter.use("/archives", bucketCors, bucketRateLimit, archivesRouter);
bucketRouter.use("/shares", sharesRouter);
bucketRouter.use("/permissions", permissionsRouter);
bucketRouter.use("/lifecycle", lifecycleRouter);
bucketRouter.use("/owner", ownerRouter);
// Every multipart route — initiate, part upload, complete, abort — lives
// under a single `/buckets/:name/multipart` namespace. Object key travels in
// the initiate body, keeping the path clear of splats. Same per-bucket CORS
// and rate-limit governance that /objects gets, so large part uploads can't
// bypass tenant quotas.
bucketRouter.use("/multipart", bucketCors, bucketRateLimit, multipartRouter);

bucketRouter.get("/my-permissions", getMyPermissions);

bucketRouter.get("/", requirePermission(PERMISSIONS.buckets.read), getBucket);
bucketRouter.put(
  "/",
  requirePermission(PERMISSIONS.buckets.write),
  updateBucket
);
bucketRouter.delete(
  "/",
  requirePermission(PERMISSIONS.buckets.delete),
  deleteBucket
);

export default bucketRouter;
