import { listSigningKeys, rotateSigningKeys } from "./controllers.js";
import { requirePermission } from "../../../../middleware/auth.js";
import { Router } from "express";

const signingKeysRouter = Router();

signingKeysRouter.post(
  "/rotate",
  requirePermission("settings.write"),
  rotateSigningKeys
);

signingKeysRouter.get("/", requirePermission("settings.read"), listSigningKeys);

export default signingKeysRouter;
