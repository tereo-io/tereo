import { smallBodyParsers } from "../../middleware/bodyParsers.js";
import notificationsRouter from "./notifications/index.js";
import webhooksRouter from "./webhooks/index.js";
import accountRouter from "./account/index.js";
import filesRouter from "./files/index.js";
import auditRouter from "./audit/index.js";
import adminRouter from "./admin/index.js";
import setupRouter from "./setup/index.js";
import { Router } from "express";

/** Core's own API, mounted at /v1. A later version mounts beside it. */
const v1Router = Router();

// Files, webhooks, audit and notifications parse bodies in their own routers,
// after authentication; each sets its limits there.
v1Router.use("/files", filesRouter);
v1Router.use("/webhooks", webhooksRouter);
v1Router.use("/audit", auditRouter);
v1Router.use("/notifications", notificationsRouter);

// Account, admin and setup — /v1/account, /v1/admin, /v1/setup.
v1Router.use("/account", ...smallBodyParsers, accountRouter);
v1Router.use("/admin", ...smallBodyParsers, adminRouter);
v1Router.use("/setup", ...smallBodyParsers, setupRouter);

export default v1Router;
