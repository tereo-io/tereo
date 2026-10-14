import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { getNotification, retryNotification } from "./controllers.js";
import { Router } from "express";

const { READ, ADMIN } = PERMISSIONS.NOTIFICATIONS;

const router = Router({ mergeParams: true });

router.post("/retry", requirePermission(ADMIN), retryNotification);
router.get("/", requirePermission(READ), getNotification);

export default router;
