import { requirePermission } from "../../../../../../middleware/auth.js";
import { sendEmailVerification } from "./controllers.js";
import { Router } from "express";

const emailVerificationRouter = Router({ mergeParams: true });

emailVerificationRouter.post(
  "/",
  requirePermission("users.write"),
  sendEmailVerification
);

export default emailVerificationRouter;
