import { requirePermission } from "../../../../../../middleware/auth.js";
import { listUserGroups } from "./controllers.js";
import { Router } from "express";

const groupsRouter = Router({ mergeParams: true });

groupsRouter.get("/", requirePermission("users.read"), listUserGroups);

export default groupsRouter;
