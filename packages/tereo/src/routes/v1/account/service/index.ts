import { getOwnService } from "./controllers.js";
import { Router } from "express";

const serviceRouter = Router();

serviceRouter.get("/", getOwnService);

export default serviceRouter;
