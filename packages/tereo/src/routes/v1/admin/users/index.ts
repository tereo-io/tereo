import { requirePermission } from "../../../../middleware/auth.js";
import { createUser, listUsers } from "./controllers.js";
import userRouter from "./user/index.js";
import { Router } from "express";

const usersRouter = Router();

usersRouter.use("/:id", userRouter);

usersRouter.get("/", requirePermission("users.read"), listUsers);
usersRouter.post("/", requirePermission("users.write"), createUser);

export default usersRouter;
