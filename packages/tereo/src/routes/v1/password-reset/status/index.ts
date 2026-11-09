import { getPasswordResetStatus } from "./controllers.js";
import { Router } from "express";

const statusRouter = Router();

statusRouter.get("/", getPasswordResetStatus);

export default statusRouter;
