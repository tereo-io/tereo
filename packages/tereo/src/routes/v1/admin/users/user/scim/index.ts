import { requirePermission } from "../../../../../../middleware/auth.js";
import { unlinkUser } from "./controllers.js";
import { Router } from "express";

const scimRouter = Router({ mergeParams: true });

scimRouter.delete("/", requirePermission("users.write"), unlinkUser);

export default scimRouter;
