import { postPasswordReset } from "./controllers.js";
import statusRouter from "./status/index.js";
import { Router } from "express";
import {
  rateLimitGeneral,
  rateLimitPreAuth,
} from "../../../middleware/rateLimit.js";

// No authentication: anyone may ask for a reset link to be sent to an address.
const passwordResetRouter = Router();

passwordResetRouter.use(rateLimitPreAuth, rateLimitGeneral);

passwordResetRouter.use("/status", statusRouter);
passwordResetRouter.post("/", postPasswordReset);

export default passwordResetRouter;
