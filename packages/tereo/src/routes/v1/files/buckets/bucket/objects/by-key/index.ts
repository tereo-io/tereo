import objectRouter from "./object/index.js";
import { Router } from "express";

/**
 * Key-addressed metadata lookup, at `/buckets/:name/objects/by-key/*objectKey`.
 * Returns the full serialized object (incl. `id`) for callers that only hold
 * a key and need the id for subsequent id-addressed mutations.
 */
const byKeyRouter = Router({ mergeParams: true });

byKeyRouter.use("/*objectKey", objectRouter);

export default byKeyRouter;
