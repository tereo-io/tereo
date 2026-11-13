import { scimBodyParsers } from "../../../middleware/bodyParsers.js";
import { requireScimToken, scimErrorHandler } from "./middleware.js";
import groupsRouter from "./groups/index.js";
import usersRouter from "./users/index.js";
import { Router } from "express";
import {
  rateLimitPreAuth,
  rateLimitScim,
} from "../../../middleware/rateLimit.js";
import {
  getServiceProviderConfig,
  getResourceTypes,
  getSchemas,
  notFound,
} from "./controllers.js";

const router = Router();

// Nothing is parsed before the token is known.
router.use(
  rateLimitPreAuth,
  requireScimToken,
  rateLimitScim,
  ...scimBodyParsers
);

router.get("/ServiceProviderConfig", getServiceProviderConfig);
router.get("/ResourceTypes", getResourceTypes);
router.get("/Schemas", getSchemas);
router.use("/Users", usersRouter);
router.use("/Groups", groupsRouter);

router.use(notFound);
router.use(scimErrorHandler);

export default router;
