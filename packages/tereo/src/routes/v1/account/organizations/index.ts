import { rateLimitGeneral } from "../../../../middleware/rateLimit.js";
import { createRequireAuth } from "../../../../middleware/auth.js";
import { listAccountOrganizations } from "./controllers.js";
import { Router } from "express";

const organizationsRouter = Router();

// Its own admission: core:organizations opens this list and nothing else.
organizationsRouter.use(
  createRequireAuth({ area: ["account", "organizations"] })
);
organizationsRouter.use(rateLimitGeneral);

organizationsRouter.get("/", listAccountOrganizations);

export default organizationsRouter;
