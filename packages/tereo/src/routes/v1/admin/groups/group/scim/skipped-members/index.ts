import { listSkippedMembers } from "./controllers.js";
import { Router } from "express";

const skippedMembersRouter = Router({ mergeParams: true });

skippedMembersRouter.get("/", listSkippedMembers);

export default skippedMembersRouter;
