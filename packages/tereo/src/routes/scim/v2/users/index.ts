import * as controllers from "./controllers.js";
import userRouter from "./user/index.js";
import { Router } from "express";

const usersRouter = Router();

usersRouter.use("/:id", userRouter);

usersRouter.get("/", controllers.listUsers);

export default usersRouter;
