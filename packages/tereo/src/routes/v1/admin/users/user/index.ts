import { requirePermission } from "../../../../../middleware/auth.js";
import emailVerificationRouter from "./email-verification/index.js";
import identityInvitesRouter from "./identity-invites/index.js";
import identitiesRouter from "./identities/index.js";
import promoteRouter from "./promote/index.js";
import groupsRouter from "./groups/index.js";
import totpRouter from "./totp/index.js";
import { Router } from "express";
import {
  getUser,
  getUserPermissions,
  getUserRoles,
  getUserSessions,
  revokeAllUserSessions,
  revokeUserSession,
  setUserRoles,
  updateUser,
} from "./controllers.js";

const userRouter = Router({ mergeParams: true });

userRouter.use("/totp", totpRouter);
userRouter.use("/groups", groupsRouter);
userRouter.use("/identities", identitiesRouter);
userRouter.use("/identity-invites", identityInvitesRouter);
userRouter.use("/email-verification", emailVerificationRouter);
userRouter.use("/promote", promoteRouter);

userRouter.delete(
  "/sessions/all",
  requirePermission("users.delete"),
  revokeAllUserSessions
);
userRouter.get("/sessions", requirePermission("users.read"), getUserSessions);
userRouter.delete(
  "/sessions",
  requirePermission("users.delete"),
  revokeUserSession
);

userRouter.get(
  "/permissions",
  requirePermission("users.read"),
  getUserPermissions
);
userRouter.get("/roles", requirePermission("users.read"), getUserRoles);
userRouter.put("/roles", requirePermission("users.write"), setUserRoles);

userRouter.get("/", requirePermission("users.read"), getUser);
userRouter.patch("/", requirePermission("users.write"), updateUser);

export default userRouter;
