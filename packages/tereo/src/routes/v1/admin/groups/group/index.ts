import membersRouter from "./members/index.js";
import rolesRouter from "./roles/index.js";
import { Router } from "express";
import {
  archiveGroup,
  getGroup,
  restoreGroup,
  updateGroup,
} from "./controllers.js";

// Each controller authorizes through loadAuthorizedGroup (middleware.ts).
const groupRouter = Router({ mergeParams: true });

groupRouter.use("/members", membersRouter);
groupRouter.use("/roles", rolesRouter);
groupRouter.post("/archive", archiveGroup);
groupRouter.post("/restore", restoreGroup);

groupRouter.get("/", getGroup);
groupRouter.patch("/", updateGroup);

export default groupRouter;
