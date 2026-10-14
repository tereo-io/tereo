import { createRequireAuth } from "../../../middleware/auth.js";
import eventTypesRouter from "./event-types/index.js";
import webhooksRouter from "./webhooks/index.js";
import eventsRouter from "./events/index.js";
import { Router } from "express";
import {
  rateLimitGeneral,
  rateLimitPreAuth,
} from "../../../middleware/rateLimit.js";

const apiRouter = Router();

// Apply authentication and rate limiting to all routes
apiRouter.use(rateLimitPreAuth);
apiRouter.use(createRequireAuth({ area: "webhooks" }));
apiRouter.use(rateLimitGeneral);

apiRouter.use("/event-types", eventTypesRouter);
apiRouter.use("/webhooks", webhooksRouter);
apiRouter.use("/events", eventsRouter);

export default apiRouter;
