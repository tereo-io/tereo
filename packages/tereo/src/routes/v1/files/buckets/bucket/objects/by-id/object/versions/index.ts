import { listObjectVersionsById } from "./controllers.js";
import versionRouter from "./version/index.js";
import { Router } from "express";

/**
 * Mounted at `/versions` by the byId router. Inherits `:name` (bucket) and
 * `:id` via mergeParams.
 */
const versionsByIdRouter = Router({ mergeParams: true });

versionsByIdRouter.use("/:versionId", versionRouter);

versionsByIdRouter.get("/", listObjectVersionsById);

export default versionsByIdRouter;
