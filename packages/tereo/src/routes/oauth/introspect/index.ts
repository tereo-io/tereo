import { introspectHandler } from "./controllers.js";
import { Router } from "express";

const introspectRouter = Router();

introspectRouter.post("/", introspectHandler);

export default introspectRouter;
