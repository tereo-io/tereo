import { requirePermission } from "../../../../../../../middleware/auth.js";
import { unlinkUserIdentity } from "./controllers.js";
import { Router } from "express";

const identityRouter = Router({ mergeParams: true });

identityRouter.delete(
  "/",
  requirePermission("users.write"),
  unlinkUserIdentity
);

export default identityRouter;
