import { removeMember, updateMemberRole } from "./controllers.js";
import rolesRouter from "./roles/index.js";
import { Router } from "express";

const memberRouter = Router({ mergeParams: true });

memberRouter.use("/roles", rolesRouter);

// Auth checked in controllers via requireOrgRole
memberRouter.patch("/", updateMemberRole);
memberRouter.delete("/", removeMember);

export default memberRouter;
