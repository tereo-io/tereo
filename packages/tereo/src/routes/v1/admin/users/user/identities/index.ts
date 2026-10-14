import { requirePermission } from "../../../../../../middleware/auth.js";
import { listUserIdentities } from "./controllers.js";
import identityRouter from "./identity/index.js";
import { Router } from "express";

const identitiesRouter = Router({ mergeParams: true });

identitiesRouter.use("/:identityId", identityRouter);

identitiesRouter.get("/", requirePermission("users.read"), listUserIdentities);

export default identitiesRouter;
