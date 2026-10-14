import { getHealth } from "./controllers.js";
import { Router } from "express";

const healthRouter = Router();

healthRouter.get("/", getHealth);

export default healthRouter;
