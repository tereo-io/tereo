import { resolveAuditOrganizationId } from "../../../../../../../middleware/organizationId.js";
import { PERMISSIONS } from "../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../middleware/auth.js";
import * as controllers from "./controllers.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.get(
  "/",
  requirePermission(PERMISSIONS.AUDIT_LOGS.READ),
  resolveAuditOrganizationId,
  controllers.getByEntity
);

export default router;
