import { requireCoreUi, requireRecentLogin } from "../middleware.js";
import { Router } from "express";
import {
  getTotpStatus,
  initiateSetup,
  verifySetup,
  disableTotp,
  regenerateRecoveryCodes,
} from "./controllers.js";

const totpRouter = Router();

totpRouter.post(
  "/recovery-codes",
  requireCoreUi,
  requireRecentLogin,
  regenerateRecoveryCodes
);

totpRouter.post("/setup/verify", requireCoreUi, verifySetup);
totpRouter.post("/setup", requireCoreUi, requireRecentLogin, initiateSetup);

totpRouter.get("/", getTotpStatus);
totpRouter.delete("/", requireCoreUi, requireRecentLogin, disableTotp);

export default totpRouter;
