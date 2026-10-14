import { requirePermission } from "../../../../../../../middleware/auth.js";
import { deleteDomain, getDomain, updateDomain } from "./controllers.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.get("/", requirePermission("identity-providers.read"), getDomain);
router.patch("/", requirePermission("identity-providers.write"), updateDomain);
router.delete("/", requirePermission("identity-providers.write"), deleteDomain);

export default router;
