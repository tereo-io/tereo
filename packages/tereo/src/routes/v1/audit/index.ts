import { createRequireAuth } from "../../../middleware/auth.js";
import entriesRouter from "./entries/index.js";
import { Router } from "express";
import {
  rateLimitGeneral,
  rateLimitPreAuth,
} from "../../../middleware/rateLimit.js";

const apiRouter = Router();

// Apply authentication and rate limiting to all routes
apiRouter.use(rateLimitPreAuth);
apiRouter.use(createRequireAuth({ area: "audit" }));
apiRouter.use(rateLimitGeneral);

apiRouter.use("/entries", entriesRouter);

export default apiRouter;
