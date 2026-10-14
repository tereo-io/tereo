import shareRouter from "./share/index.js";
import { Router } from "express";

const byIdRouter = Router({ mergeParams: true });

byIdRouter.use("/:id", shareRouter);

export default byIdRouter;
