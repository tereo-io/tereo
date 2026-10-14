import { resolveAuditOrganizationId } from "../../../../../middleware/organizationId.js";
import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.get(
  "/",
  requirePermission(PERMISSIONS.AUDIT_LOGS.READ),
  resolveAuditOrganizationId,
  controllers.getEntry
);
// No by-id delete: an audit log must be tamper-evident, so individual entries
// are never removable via the API. Lifecycle is handled solely by time/policy-
// based partition retention (jobs/entryRetention.ts).

export default router;
