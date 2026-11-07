import { inspectPasswordSetup } from "./controllers.js";
import { Router } from "express";

const inspectRouter = Router();

inspectRouter.post("/", inspectPasswordSetup);

export default inspectRouter;
