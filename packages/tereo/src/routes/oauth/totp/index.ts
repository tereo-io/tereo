import { Router } from "express";
import {
  totpVerifyHandler,
  totpRecoveryHandler,
  totpSetupInitiateHandler,
  totpSetupVerifyHandler,
} from "./controllers.js";

const router = Router();

router.post("/verify", totpVerifyHandler);
router.post("/recovery", totpRecoveryHandler);

router.post("/setup", totpSetupInitiateHandler);
router.post("/setup/verify", totpSetupVerifyHandler);

export default router;
