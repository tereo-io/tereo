import { requirePermission } from "../../../../../../../middleware/auth.js";
import { guardArchivedRoleChild } from "../../middleware.js";
import { removeRoleUser } from "./controllers.js";
import { Router } from "express";

const userRouter = Router({ mergeParams: true });

userRouter.delete(
  "/",
  requirePermission("roles.delete"),
  guardArchivedRoleChild,
  removeRoleUser
);

export default userRouter;
