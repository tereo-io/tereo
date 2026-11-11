import { requirePermission } from "../../../../../../../../middleware/auth.js";
import { revokeScimToken } from "./controllers.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.delete(
  "/",
  requirePermission("identity-providers.write"),
  revokeScimToken
);

export default router;
