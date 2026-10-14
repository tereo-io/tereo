import { resolveAuditOrganizationId } from "../../../../middleware/organizationId.js";
import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { requirePermission } from "../../../../middleware/auth.js";
import * as controllers from "./controllers.js";
import entityRouter from "./entity/index.js";
import entryRouter from "./entry/index.js";
import { Router } from "express";

const router = Router();

router.use("/entity", entityRouter);

router.post(
  "/batch",
  requirePermission(PERMISSIONS.AUDIT_LOGS.WRITE),
  controllers.createBatch
);

router.get(
  "/facets",
  requirePermission(PERMISSIONS.AUDIT_LOGS.READ),
  resolveAuditOrganizationId,
  controllers.facets
);

router.use("/:id", entryRouter);

router.post(
  "/",
  requirePermission(PERMISSIONS.AUDIT_LOGS.WRITE),
  controllers.createEntry
);

router.get(
  "/",
  requirePermission(PERMISSIONS.AUDIT_LOGS.READ),
  resolveAuditOrganizationId,
  controllers.list
);

export default router;
