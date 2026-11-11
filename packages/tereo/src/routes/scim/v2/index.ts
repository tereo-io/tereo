import { scimBodyParsers } from "../../../middleware/bodyParsers.js";
import { requireScimToken, scimErrorHandler } from "./middleware.js";
import { rateLimitScim } from "../../../middleware/rateLimit.js";
import { Router } from "express";
import {
  getServiceProviderConfig,
  getResourceTypes,
  getSchemas,
  notFound,
} from "./controllers.js";

const router = Router();

router.use(...scimBodyParsers, requireScimToken, rateLimitScim);

router.get("/ServiceProviderConfig", getServiceProviderConfig);
router.get("/ResourceTypes", getResourceTypes);
router.get("/Schemas", getSchemas);
// /Users is mounted here by the Users task.

router.use(notFound);
router.use(scimErrorHandler);

export default router;
