import { bucketRateLimit } from "../../../../../../middleware/bucketRateLimit.js";
import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { bucketCors } from "../../../../../../middleware/bucketCors.js";
import objectRouter from "./object/index.js";
import byKeyRouter from "./by-key/index.js";
import byIdRouter from "./by-id/index.js";
import { Router } from "express";
import {
  bulkDeleteObjects,
  listObjectPrefixes,
  listObjects,
  purgeNonCurrentVersions,
} from "./controllers.js";

/**
 * Collection-level routes for objects within a bucket. Writes (DELETE, PATCH,
 * version ops, presign) live under `./by-id/object/` and are addressed by the object's
 * UUID `id`. Key-addressed routes (upload PUT, download GET/HEAD) live under
 * `./object/` — upload stays key-based because it is the identity-creator
 * operation. Multipart routes (including `POST /buckets/:name/multipart` for
 * initiation) live at the bucket level, not under `/objects/`.
 */
const objectsRouter = Router({ mergeParams: true });

// Per-bucket CORS and per-bucket rate limiting apply to every object route —
// both are no-ops when the bucket has no config set, so the global middleware
// applies in that case.
objectsRouter.use(bucketCors);
objectsRouter.use(bucketRateLimit);

// Id-addressed mutations + nested version routes. Mounted BEFORE the wildcard
// `*objectKey` router so the literal `by-id/` prefix is never interpreted as
// an object key.
objectsRouter.use("/by-id", byIdRouter);

// Key-addressed metadata lookup — returns the full serialized object (incl.
// `id`) for callers that only hold a key and need the id for subsequent
// id-addressed mutations. Mounted before the catch-all so `by-key/` wins.
objectsRouter.use("/by-key", byKeyRouter);

// Collection endpoints — must be declared before the wildcard mount so the
// literal prefixes route isn't swallowed as an object key.
objectsRouter.get("/prefixes", listObjectPrefixes);
objectsRouter.post(
  "/bulk-delete",
  requirePermission(PERMISSIONS.objects.delete),
  bulkDeleteObjects
);
objectsRouter.post(
  "/purge-non-current-versions",
  requirePermission(PERMISSIONS.objects.delete),
  purgeNonCurrentVersions
);

// Base per-object routes (PUT upload, GET download, HEAD metadata) live under
// the catch-all wildcard mount. No DELETE / presign / versions / multipart
// here anymore — those moved to `by-id/` (mutations) or the bucket-level
// `/multipart` router.
objectsRouter.use("/*objectKey", objectRouter);

objectsRouter.get("/", listObjects);

export default objectsRouter;
