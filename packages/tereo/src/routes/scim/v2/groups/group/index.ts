import * as controllers from "./controllers.js";
import { Router } from "express";

const groupRouter = Router({ mergeParams: true });

groupRouter.get("/", controllers.getGroup);
groupRouter.delete("/", controllers.deleteGroup);

export default groupRouter;
