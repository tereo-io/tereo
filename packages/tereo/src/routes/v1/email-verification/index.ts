import { rateLimitGeneral } from "../../../middleware/rateLimit.js";
import inspectRouter from "./inspect/index.js";
import { verifyEmail } from "./controllers.js";
import { Router } from "express";

// No authentication: the verify link's token is the credential.
const emailVerificationRouter = Router();

emailVerificationRouter.use(rateLimitGeneral);

emailVerificationRouter.use("/inspect", inspectRouter);
emailVerificationRouter.post("/", verifyEmail);

export default emailVerificationRouter;
