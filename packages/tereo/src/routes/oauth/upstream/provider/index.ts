import { upstreamCallback, upstreamStart } from "./controllers.js";
import { Router } from "express";

const providerRouter = Router({ mergeParams: true });

providerRouter.get("/callback", upstreamCallback);
providerRouter.get("/start", upstreamStart);

export default providerRouter;
