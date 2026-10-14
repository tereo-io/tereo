import { requireCoreUi, requireRecentLogin } from "../../middleware.js";
import { unlinkOwnIdentity } from "./controllers.js";
import { Router } from "express";

const identityRouter = Router({ mergeParams: true });

identityRouter.delete(
  "/",
  requireCoreUi,
  requireRecentLogin,
  unlinkOwnIdentity
);

export default identityRouter;
