import { rateLimitGeneral } from "../../../middleware/rateLimit.js";
import { setPassword } from "./controllers.js";
import inspectRouter from "./inspect/index.js";
import { Router } from "express";

// No authentication: the setup link's token is the credential.
const passwordSetupRouter = Router();

passwordSetupRouter.use(rateLimitGeneral);

passwordSetupRouter.use("/inspect", inspectRouter);
passwordSetupRouter.post("/", setPassword);

export default passwordSetupRouter;
