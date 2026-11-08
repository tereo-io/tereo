import { handleMulterErrors, requireBrandingEditor } from "./middleware.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { uploadAsset } from "./controllers.js";
import { Router } from "express";

const router = Router();

router.post(
  "/",
  requirePermission("branding.write"),
  requireBrandingEditor,
  handleMulterErrors,
  uploadAsset
);

export default router;
