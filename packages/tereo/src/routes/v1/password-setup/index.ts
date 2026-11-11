import { refuseForeignOrigins } from "../../../middleware/originCheck.js";
import { rateLimitGeneral } from "../../../middleware/rateLimit.js";
import { setPassword } from "./controllers.js";
import inspectRouter from "./inspect/index.js";
import { Router } from "express";

// No authentication: the setup link's token is the credential.
const passwordSetupRouter = Router();

// Before the limiters, which a refused request must not spend.
passwordSetupRouter.use(refuseForeignOrigins, rateLimitGeneral);

passwordSetupRouter.use("/inspect", inspectRouter);
passwordSetupRouter.post("/", setPassword);

export default passwordSetupRouter;
