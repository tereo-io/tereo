import * as controllers from "./controllers.js";
import { Router } from "express";

const userRouter = Router({ mergeParams: true });

userRouter.get("/", controllers.getUser);
userRouter.put("/", controllers.replaceUser);
userRouter.patch("/", controllers.patchUser);

export default userRouter;
