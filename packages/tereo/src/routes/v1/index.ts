import { smallBodyParsers } from "../../middleware/bodyParsers.js";
import notificationsRouter from "./notifications/index.js";
import webhooksRouter from "./webhooks/index.js";
import registryRouter from "./registry/index.js";
import accountRouter from "./account/index.js";
import filesRouter from "./files/index.js";
import auditRouter from "./audit/index.js";
import adminRouter from "./admin/index.js";
import setupRouter from "./setup/index.js";
import express, { Router } from "express";

/** Core's own API, mounted at /v1. A later version mounts beside it. */
const v1Router = Router();

// Files — /v1/files.
v1Router.use("/files", filesRouter);

// Webhooks — /v1/webhooks, and audit — /v1/audit.
v1Router.use(
  "/webhooks",
  express.json({ limit: "10mb" }),
  express.urlencoded({ extended: true, limit: "10mb" }),
  webhooksRouter
);
v1Router.use(
  "/audit",
  express.json({ limit: "10mb" }),
  express.urlencoded({ extended: true, limit: "10mb" }),
  auditRouter
);

// Notifications — /v1/notifications. Content is inline, attachments are
// references to stored objects.
v1Router.use(
  "/notifications",
  express.json({ limit: "10mb" }),
  notificationsRouter
);

// Registry — /v1/registry. Declarations list every permission, role, bucket
// and event type a service owns, so they outgrow the auth routes' limit.
v1Router.use("/registry", express.json({ limit: "1mb" }), registryRouter);

// Account, admin and setup — /v1/account, /v1/admin, /v1/setup.
v1Router.use("/account", ...smallBodyParsers, accountRouter);
v1Router.use("/admin", ...smallBodyParsers, adminRouter);
v1Router.use("/setup", ...smallBodyParsers, setupRouter);

export default v1Router;
