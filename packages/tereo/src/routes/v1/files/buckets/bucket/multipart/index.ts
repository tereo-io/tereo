import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { initiateMultipart } from "./controllers.js";
import uploadRouter from "./upload/index.js";
import { Router } from "express";
import express from "express";

/**
 * Mounted at `/buckets/:name/multipart`. Every multipart route lives under
 * one namespace — initiation included. The object's key travels in the
 * request body (`POST /multipart { objectKey, ... }`) so no splat is needed.
 */
const multipartRouter = Router({ mergeParams: true });

// Per-upload routes (list/abort/complete + nested parts) mount BEFORE the
// base `/` handler so the `:uploadId` path doesn't swallow POST /.
multipartRouter.use("/:uploadId", uploadRouter);

// POST /buckets/:name/multipart — initiate
multipartRouter.post(
  "/",
  requirePermission(PERMISSIONS.objects.write),
  express.json({ limit: "1mb" }),
  initiateMultipart
);

export default multipartRouter;
