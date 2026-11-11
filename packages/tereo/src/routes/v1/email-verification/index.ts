import { refuseForeignOrigins } from "../../../middleware/originCheck.js";
import { rateLimitGeneral } from "../../../middleware/rateLimit.js";
import inspectRouter from "./inspect/index.js";
import { verifyEmail } from "./controllers.js";
import { Router } from "express";

// No authentication: the verify link's token is the credential.
const emailVerificationRouter = Router();

// Before the limiters, which a refused request must not spend.
emailVerificationRouter.use(refuseForeignOrigins, rateLimitGeneral);

emailVerificationRouter.use("/inspect", inspectRouter);
emailVerificationRouter.post("/", verifyEmail);

export default emailVerificationRouter;
