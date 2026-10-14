import { PERMISSIONS } from "../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { Router } from "express";
import {
  deleteConnection,
  getConnection,
  setDefaultConnection,
  testConnection,
  updateConnection,
} from "./controllers.js";

const { READ, ADMIN } = PERMISSIONS.NOTIFICATIONS;

const router = Router({ mergeParams: true });

router.post("/default", requirePermission(ADMIN), setDefaultConnection);
router.post("/test", requirePermission(ADMIN), testConnection);

router.get("/", requirePermission(READ), getConnection);
router.patch("/", requirePermission(ADMIN), updateConnection);
router.delete("/", requirePermission(ADMIN), deleteConnection);

export default router;
