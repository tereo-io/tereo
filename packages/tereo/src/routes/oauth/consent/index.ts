import { consentGetHandler, consentPostHandler } from "./controllers.js";
import { Router } from "express";

const router = Router();

router.get("/", consentGetHandler);
router.post("/", consentPostHandler);

export default router;
