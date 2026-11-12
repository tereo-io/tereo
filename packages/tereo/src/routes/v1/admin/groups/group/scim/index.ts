import skippedMembersRouter from "./skipped-members/index.js";
import { unlinkGroup } from "./controllers.js";
import { Router } from "express";

const scimRouter = Router({ mergeParams: true });

scimRouter.use("/skipped-members", skippedMembersRouter);

scimRouter.delete("/", unlinkGroup);

export default scimRouter;
