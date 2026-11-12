import { requirePermission } from "../../../../../../../middleware/auth.js";
import { releaseUser } from "./controllers.js";
import { Router } from "express";

const releaseRouter = Router({ mergeParams: true });

releaseRouter.put("/", requirePermission("users.write"), releaseUser);

export default releaseRouter;
