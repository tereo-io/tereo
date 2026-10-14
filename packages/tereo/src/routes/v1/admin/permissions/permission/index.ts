import { requirePermission } from "../../../../../middleware/auth.js";
import { getPermission } from "./controllers.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.get("/", requirePermission("permissions.read"), getPermission);

export default router;
