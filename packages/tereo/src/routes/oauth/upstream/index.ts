import providerRouter from "./provider/index.js";
import { listProviders } from "./controllers.js";
import { Router } from "express";

const upstreamRouter = Router();

upstreamRouter.get("/providers", listProviders);

upstreamRouter.use("/:slug", providerRouter);

export default upstreamRouter;
