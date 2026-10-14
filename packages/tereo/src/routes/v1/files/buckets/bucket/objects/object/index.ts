import { PERMISSIONS } from "../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../middleware/auth.js";
import { handleMulterErrors } from "./middleware.js";
import { Router } from "express";
import {
  authorizeUpload,
  downloadObject,
  getObjectMetadata,
  uploadObject,
} from "./controllers.js";

/**
 * Key-addressed read/upload router — mounted at `/*objectKey` by the parent
 * objects router. Only PUT (upload, the identity creator), GET (download) and
 * HEAD (metadata) live here. Every mutation on an existing object lives under
 * `../by-id/object/` and is addressed by `id`. The multipart-initiate sub-mount
 * stays keyed by `objectKey` on the parent router (it is also an identity
 * creator, like PUT).
 *
 * Inherits `:name` (bucket) and `*objectKey` via mergeParams.
 */
const objectRouter = Router({ mergeParams: true });

objectRouter.put(
  "/",
  requirePermission(PERMISSIONS.objects.write),
  authorizeUpload,
  handleMulterErrors,
  uploadObject
);
objectRouter.head("/", getObjectMetadata);
objectRouter.get("/", downloadObject);

export default objectRouter;
