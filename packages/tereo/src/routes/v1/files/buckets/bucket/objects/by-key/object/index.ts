import { getObjectByKey } from "./controllers.js";
import { Router } from "express";

const objectRouter = Router({ mergeParams: true });

objectRouter.get("/", getObjectByKey);

export default objectRouter;
