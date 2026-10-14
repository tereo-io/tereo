import { createRequireAuth } from "../../../middleware/auth.js";
import { postDeclaration } from "./controllers.js";
import { Router } from "express";
import {
  rateLimitGeneral,
  rateLimitPreAuth,
} from "../../../middleware/rateLimit.js";

// Called by app services on every start, with their own client-credentials
// token. The declaration applies to the caller's service.
const registryRouter = Router();

registryRouter.use(rateLimitPreAuth);
registryRouter.use(createRequireAuth({ area: "registry" }));
registryRouter.use(rateLimitGeneral);

registryRouter.post("/declaration", postDeclaration);

export default registryRouter;
