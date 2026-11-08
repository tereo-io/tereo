import { createGroup, listGroups } from "./controllers.js";
import groupRouter from "./group/index.js";
import { Router } from "express";

// Authorization is in the controllers: `groups.*`, or for an organization's
// groups its admins and owners (group/middleware.ts).
const groupsRouter = Router();

groupsRouter.use("/:id", groupRouter);

groupsRouter.get("/", listGroups);
groupsRouter.post("/", createGroup);

export default groupsRouter;
