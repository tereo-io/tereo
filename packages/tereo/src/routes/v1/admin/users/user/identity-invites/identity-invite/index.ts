import { requirePermission } from "../../../../../../../middleware/auth.js";
import { withdrawIdentityInvite } from "./controllers.js";
import { Router } from "express";

const identityInviteRouter = Router({ mergeParams: true });

identityInviteRouter.delete(
  "/",
  requirePermission("users.write"),
  withdrawIdentityInvite
);

export default identityInviteRouter;
