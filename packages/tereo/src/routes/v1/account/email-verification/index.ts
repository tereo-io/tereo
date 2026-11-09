import { resendEmailVerification } from "./controllers.js";
import { Router } from "express";

const emailVerificationRouter = Router();

emailVerificationRouter.post("/", resendEmailVerification);

export default emailVerificationRouter;
