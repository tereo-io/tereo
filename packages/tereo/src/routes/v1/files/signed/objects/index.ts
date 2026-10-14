import bucketRouter from "./bucket/index.js";
import { Router } from "express";

const objectsRouter = Router();

objectsRouter.use("/:bucket", bucketRouter);

export default objectsRouter;
