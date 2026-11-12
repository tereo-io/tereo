import { requirePermission } from "../../../../../../../middleware/auth.js";
import { createScimToken } from "./controllers.js";
import tokenRouter from "./token/index.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.use("/:tokenId", tokenRouter);

router.post(
  "/",
  requirePermission("identity-providers.write"),
  createScimToken
);

export default router;
