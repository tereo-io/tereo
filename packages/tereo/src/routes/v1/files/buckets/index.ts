import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { requirePermission } from "../../../../middleware/auth.js";
import { listBuckets, createBucket } from "./controllers.js";
import bucketRouter from "./bucket/index.js";
import { Router } from "express";

const bucketsRouter = Router();

bucketsRouter.use("/:name", bucketRouter);

bucketsRouter.get(
  "/",
  requirePermission(PERMISSIONS.buckets.read),
  listBuckets
);
bucketsRouter.post(
  "/",
  requirePermission(PERMISSIONS.buckets.write),
  createBucket
);

export default bucketsRouter;
