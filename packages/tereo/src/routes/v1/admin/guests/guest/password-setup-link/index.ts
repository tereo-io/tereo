import { requirePermission } from "../../../../../../middleware/auth.js";
import { issueGuestPasswordSetupLink } from "./controllers.js";
import { Router } from "express";

const passwordSetupLinkRouter = Router({ mergeParams: true });

passwordSetupLinkRouter.post(
  "/",
  requirePermission("users.guests.write"),
  issueGuestPasswordSetupLink
);

export default passwordSetupLinkRouter;
