import { revokeHandler } from "./controllers.js";
import { Router } from "express";

const revokeRouter = Router();

revokeRouter.post("/", revokeHandler);

export default revokeRouter;
