import { requirePermission } from "../../../../../../middleware/auth.js";
import releaseRouter from "./release/index.js";
import { unlinkUser } from "./controllers.js";
import { Router } from "express";

const scimRouter = Router({ mergeParams: true });

scimRouter.use("/release", releaseRouter);
scimRouter.delete("/", requirePermission("users.write"), unlinkUser);

export default scimRouter;
