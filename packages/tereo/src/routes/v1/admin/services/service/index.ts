import { requirePermission } from "../../../../../middleware/auth.js";
import { Router } from "express";
import {
  approveAccess,
  getService,
  regenerateSecret,
  revokeAccess,
  revokePreviousSecret,
  updateService,
} from "./controllers.js";

const router = Router({ mergeParams: true });

router.post(
  "/regenerate-secret",
  requirePermission("services.write"),
  regenerateSecret
);
router.post(
  "/revoke-previous-secret",
  requirePermission("services.write"),
  revokePreviousSecret
);
router.post(
  "/access/approve",
  requirePermission("services.approve"),
  approveAccess
);
router.post(
  "/access/revoke",
  requirePermission("services.approve"),
  revokeAccess
);

router.get("/", requirePermission("services.read"), getService);
router.patch("/", requirePermission("services.write"), updateService);

export default router;
