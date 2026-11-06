import { requirePermission } from "../../../../../../middleware/auth.js";
import { promoteUser } from "./controllers.js";
import { Router } from "express";

const promoteRouter = Router({ mergeParams: true });

promoteRouter.post("/", requirePermission("users.write"), promoteUser);

export default promoteRouter;
