import { apiBodyParsers } from "../../../middleware/bodyParsers.js";
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
// Events carry their payloads inline; a batch carries many.
apiRouter.use("/events", ...apiBodyParsers("10mb"));
apiRouter.use(...apiBodyParsers());

apiRouter.use("/event-types", eventTypesRouter);
apiRouter.use("/webhooks", webhooksRouter);
apiRouter.use("/events", eventsRouter);

export default apiRouter;
