import { requirePermission } from "../../../../../middleware/auth.js";
import { handleMulterErrors } from "./middleware.js";
import { uploadAsset } from "./controllers.js";
import { Router } from "express";

const router = Router();

router.post(
  "/",
  requirePermission("branding.write"),
  handleMulterErrors,
  uploadAsset
);

export default router;
