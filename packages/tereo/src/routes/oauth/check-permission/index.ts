import { checkPermission, checkPermissions } from "./controllers.js";
import { Router } from "express";

const router = Router();

router.post("/batch", checkPermissions);
router.post("/", checkPermission);

export default router;
