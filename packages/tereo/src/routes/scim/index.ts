import { scimErrorHandler } from "./v2/middleware.js";
import { notFound } from "./v2/controllers.js";
import v2Router from "./v2/index.js";
import { Router } from "express";

const router = Router();

router.use("/v2", v2Router);
// Anything else under /scim is a SCIM error, not the admin UI's shell.
router.use(notFound);
router.use(scimErrorHandler);

export default router;
