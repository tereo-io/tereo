import objectRouter from "./object/index.js";
import { Router } from "express";

const byIdRouter = Router({ mergeParams: true });

byIdRouter.use("/:id", objectRouter);

export default byIdRouter;
