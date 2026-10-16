import { requirePermission } from "../../../../../middleware/auth.js";
import { Router } from "express";
import {
  getIntegration,
  regenerateSecret,
  revokePreviousSecret,
  setAudiences,
  setRoles,
  updateIntegration,
} from "./controllers.js";

const router = Router({ mergeParams: true });

router.post(
  "/regenerate-secret",
  requirePermission("integrations.write"),
  regenerateSecret
);
router.post(
  "/revoke-previous-secret",
  requirePermission("integrations.write"),
  revokePreviousSecret
);
router.put("/roles", requirePermission("integrations.write"), setRoles);
router.put("/audiences", requirePermission("integrations.write"), setAudiences);

router.get("/", requirePermission("integrations.read"), getIntegration);
router.patch("/", requirePermission("integrations.write"), updateIntegration);

export default router;
