import { rateLimitHealth } from "../../middleware/rateLimit.js";
import { getHealth } from "./controllers.js";
import { Router } from "express";

const healthRouter = Router();

healthRouter.get("/", rateLimitHealth, getHealth);

export default healthRouter;
