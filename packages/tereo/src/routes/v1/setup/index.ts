import { rateLimitGeneral } from "../../../middleware/rateLimit.js";
import { getSetupStatus, postSetup } from "./controllers.js";
import { Router } from "express";

// First-boot setup. No authentication: the setup token is the credential.
const setupRouter = Router();

setupRouter.use(rateLimitGeneral);

setupRouter.get("/status", getSetupStatus);
setupRouter.post("/", postSetup);

export default setupRouter;
