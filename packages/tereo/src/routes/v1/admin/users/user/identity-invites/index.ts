import { requirePermission } from "../../../../../../middleware/auth.js";
import identityInviteRouter from "./identity-invite/index.js";
import { createIdentityInvite } from "./controllers.js";
import { Router } from "express";

const identityInvitesRouter = Router({ mergeParams: true });

identityInvitesRouter.use("/:providerId", identityInviteRouter);

identityInvitesRouter.post(
  "/",
  requirePermission("users.write"),
  createIdentityInvite
);

export default identityInvitesRouter;
