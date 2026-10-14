import { requirePermission } from "../../../../../../middleware/auth.js";
import { getRoleUsers } from "./controllers.js";
import userRouter from "./user/index.js";
import { Router } from "express";

const usersRouter = Router({ mergeParams: true });

usersRouter.use("/:userId", userRouter);

usersRouter.get("/", requirePermission("roles.read"), getRoleUsers);

export default usersRouter;
