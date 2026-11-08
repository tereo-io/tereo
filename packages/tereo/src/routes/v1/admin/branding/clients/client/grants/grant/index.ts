import { requirePermission } from "../../../../../../../../middleware/auth.js";
import { revokeGrant } from "./controllers.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.delete("/", requirePermission("branding.write"), revokeGrant);

export default router;
