import partRouter from "./part/index.js";
import { Router } from "express";

const partsRouter = Router({ mergeParams: true });

partsRouter.use("/:partNumber", partRouter);

export default partsRouter;
