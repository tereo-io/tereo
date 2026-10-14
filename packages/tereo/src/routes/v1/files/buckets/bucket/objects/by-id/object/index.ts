import { PERMISSIONS } from "../../../../../../../../definitions/permissions.js";
import { deleteObjectById, getObjectById, patchObject } from "./controllers.js";
import { requirePermission } from "../../../../../../../../middleware/auth.js";
import versionsByIdRouter from "./versions/index.js";
import presignRouter from "./presign/index.js";
import { Router } from "express";

/**
 * Id-addressed object router. Mounted at `/buckets/:name/objects/by-id/:id`
 * by the parent `objects` router. Every mutation on an existing object lives
 * here — reads stay keyed by `*objectKey` for human-readable URLs.
 *
 * Inherits `:name` (bucket) and `:id` via mergeParams.
 */
const objectRouter = Router({ mergeParams: true });

// Nested sub-routers mount BEFORE the base `/` handlers so literal prefixes
// (`/versions...`, `/presign`) don't collide with the root PATCH/DELETE/GET.
objectRouter.use("/versions", versionsByIdRouter);
objectRouter.use("/presign", presignRouter);

// Reads are admitted without a token (routes/files/index.ts); the
// controllers check access with `getReadableBucket`.
objectRouter.get("/", getObjectById);
objectRouter.patch(
  "/",
  requirePermission(PERMISSIONS.objects.write),
  patchObject
);
objectRouter.delete(
  "/",
  requirePermission(PERMISSIONS.objects.delete),
  deleteObjectById
);

export default objectRouter;
