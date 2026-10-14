import { PERMISSIONS } from "../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../middleware/auth.js";
import partsRouter from "./parts/index.js";
import { Router } from "express";
import express from "express";
import {
  abortMultipart,
  completeMultipart,
  listMultipartParts,
} from "./controllers.js";

/**
 * Mounted at `/buckets/:name/multipart/:uploadId` by the multipart router.
 * Inherits `:name` (bucket) and `:uploadId` via mergeParams.
 */
const uploadRouter = Router({ mergeParams: true });

// Nested parts routes mount BEFORE the literal `/complete` and base handlers
// so the literal prefix doesn't collide with future params.
uploadRouter.use("/parts", partsRouter);

uploadRouter.post(
  "/complete",
  requirePermission(PERMISSIONS.objects.write),
  express.json({ limit: "5mb" }),
  completeMultipart
);

uploadRouter.get(
  "/",
  requirePermission(PERMISSIONS.objects.read),
  listMultipartParts
);

uploadRouter.delete(
  "/",
  requirePermission(PERMISSIONS.objects.delete),
  abortMultipart
);

export default uploadRouter;
