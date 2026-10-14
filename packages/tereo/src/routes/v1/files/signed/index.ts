import archivesRouter from "./archives/index.js";
import objectsRouter from "./objects/index.js";
import { Router } from "express";

/**
 * Presigned URLs: no auth middleware, the HMAC in the query string is the
 * credential. Objects are id-addressed (the HMAC binds the object's UUID, not
 * its key), so a rename doesn't invalidate an outstanding URL.
 */
const signedRouter = Router();

signedRouter.use("/archives", archivesRouter);
signedRouter.use("/objects", objectsRouter);

export default signedRouter;
