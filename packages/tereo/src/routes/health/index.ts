import { rateLimitHealth } from "../../middleware/rateLimit.js";
import { getHealth, getReady } from "./controllers.js";
import { Router } from "express";

const healthRouter = Router();

healthRouter.get("/ready", rateLimitHealth, getReady);
healthRouter.get("/", rateLimitHealth, getHealth);

export default healthRouter;
