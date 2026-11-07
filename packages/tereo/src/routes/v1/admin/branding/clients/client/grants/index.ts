import { requirePermission } from "../../../../../../../middleware/auth.js";
import { addGrant, listGrants } from "./controllers.js";
import grantRouter from "./grant/index.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.use("/:userId", grantRouter);
router.get("/", requirePermission("branding.read"), listGrants);
router.post("/", requirePermission("branding.write"), addGrant);

export default router;
