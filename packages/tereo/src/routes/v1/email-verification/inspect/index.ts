import { inspectEmailVerification } from "./controllers.js";
import { Router } from "express";

const inspectRouter = Router();

inspectRouter.post("/", inspectEmailVerification);

export default inspectRouter;
