import { requirePermission } from "../../../../../../middleware/auth.js";
import { Router } from "express";
import {
  deleteClientBranding,
  getClientBranding,
  putClientBranding,
} from "./controllers.js";

const router = Router({ mergeParams: true });

router.get("/", requirePermission("branding.read"), getClientBranding);
router.put("/", requirePermission("branding.write"), putClientBranding);
router.delete("/", requirePermission("branding.write"), deleteClientBranding);

export default router;
