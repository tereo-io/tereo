import { requirePermission } from "../../../../../../middleware/auth.js";
import tokensRouter from "./tokens/index.js";
import { Router } from "express";
import {
  deleteScimConnection,
  getScimConnection,
  putScimConnection,
} from "./controllers.js";

const router = Router({ mergeParams: true });

router.use("/tokens", tokensRouter);

router.get("/", getScimConnection);
router.put(
  "/",
  requirePermission("identity-providers.write"),
  putScimConnection
);
router.delete(
  "/",
  requirePermission("identity-providers.write"),
  deleteScimConnection
);

export default router;
