import * as controllers from "./controllers.js";
import groupRouter from "./group/index.js";
import { Router } from "express";

const groupsRouter = Router();

groupsRouter.use("/:id", groupRouter);

groupsRouter.get("/", controllers.listGroups);
groupsRouter.post("/", controllers.createGroup);

export default groupsRouter;
