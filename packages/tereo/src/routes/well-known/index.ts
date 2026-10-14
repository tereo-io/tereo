import { rateLimitGeneral } from "../../middleware/rateLimit.js";
import { Router } from "express";
import {
  handleOpenIdConfiguration,
  handleWellKnownJwks,
  handleWellKnownOAuth,
} from "./controllers.js";

const wellKnownRouter = Router();

wellKnownRouter.use(rateLimitGeneral);

wellKnownRouter.get("/oauth-authorization-server", handleWellKnownOAuth);
wellKnownRouter.get("/openid-configuration", handleOpenIdConfiguration);
wellKnownRouter.get("/jwks.json", handleWellKnownJwks);

export default wellKnownRouter;
