import * as controllers from "./controllers.js";
import { Router } from "express";

const userRouter = Router({ mergeParams: true });

userRouter.get("/", controllers.getUser);

export default userRouter;
