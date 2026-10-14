import { getShareViaToken, probeShareViaToken } from "../controllers.js";
import { Router } from "express";

const fileRouter = Router({ mergeParams: true });

// HEAD before GET: Express otherwise answers HEAD with the GET handler.
fileRouter.head("/", probeShareViaToken);
fileRouter.get("/", getShareViaToken);

export default fileRouter;
