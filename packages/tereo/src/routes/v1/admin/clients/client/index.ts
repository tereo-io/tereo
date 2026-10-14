import { requirePermission } from "../../../../../middleware/auth.js";
import { Router } from "express";
import {
  deleteClient,
  getClient,
  regenerateClientSecret,
  updateClient,
} from "./controllers.js";

const router = Router({ mergeParams: true });

router.post(
  "/regenerate-secret",
  requirePermission("clients.write"),
  regenerateClientSecret
);

router.get("/", requirePermission("clients.read"), getClient);
router.patch("/", requirePermission("clients.write"), updateClient);
router.delete("/", requirePermission("clients.delete"), deleteClient);

export default router;
