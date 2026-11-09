import { addMembers, listMembers } from "./controllers.js";
import memberRouter from "./member/index.js";
import { Router } from "express";

const membersRouter = Router({ mergeParams: true });

membersRouter.use("/:userId", memberRouter);

membersRouter.get("/", listMembers);
membersRouter.post("/", addMembers);

export default membersRouter;
