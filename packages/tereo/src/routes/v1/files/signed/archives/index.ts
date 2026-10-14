import archiveRouter from "./archive/index.js";
import { Router } from "express";

const archivesRouter = Router();

archivesRouter.use("/:id", archiveRouter);

export default archivesRouter;
