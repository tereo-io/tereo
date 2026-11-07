import { requirePermission } from "../../../../../middleware/auth.js";
import { Router } from "express";
import {
  deleteDefaultBranding,
  getDefaultBranding,
  putDefaultBranding,
} from "./controllers.js";

const router = Router();

router.get("/", requirePermission("branding.admin"), getDefaultBranding);
router.put("/", requirePermission("branding.admin"), putDefaultBranding);
router.delete("/", requirePermission("branding.admin"), deleteDefaultBranding);

export default router;
