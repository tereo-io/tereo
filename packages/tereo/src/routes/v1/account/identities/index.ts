import { requireCoreUi, requireRecentLogin } from "../middleware.js";
import { listIdentities, startLink } from "./controllers.js";
import identityRouter from "./identity/index.js";
import { Router } from "express";

const identitiesRouter = Router();

identitiesRouter.use("/:id", identityRouter);

identitiesRouter.get("/", listIdentities);
identitiesRouter.post("/", requireCoreUi, requireRecentLogin, startLink);

export default identitiesRouter;
