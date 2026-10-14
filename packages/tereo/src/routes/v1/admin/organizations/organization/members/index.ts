import { requirePermission } from "../../../../../../middleware/auth.js";
import { listMembers, addMember } from "./controllers.js";
import memberRouter from "./member/index.js";
import { Router } from "express";

const membersRouter = Router({ mergeParams: true });

membersRouter.use("/:userId", memberRouter);

// Listing is checked in the controller via requireOrgRole. Adding is the
// platform's alone: an organization's owners and admins manage the roles of
// members already there, and remove them, but do not add anyone.
membersRouter.get("/", listMembers);
membersRouter.post("/", requirePermission("organizations.write"), addMember);

export default membersRouter;
