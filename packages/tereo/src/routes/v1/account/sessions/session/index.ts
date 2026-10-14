import { revokeSession } from "./controllers.js";
import { Router } from "express";

const sessionRouter = Router({ mergeParams: true });

sessionRouter.delete("/", revokeSession);

export default sessionRouter;
