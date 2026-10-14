import { authorizeGetHandler, authorizePostHandler } from "./controllers.js";
import { Router } from "express";

const authorizeRouter = Router();

authorizeRouter.get("/", authorizeGetHandler);
authorizeRouter.post("/", authorizePostHandler);

export default authorizeRouter;
