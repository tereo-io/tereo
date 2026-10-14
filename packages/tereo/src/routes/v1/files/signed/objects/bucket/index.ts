import byIdRouter from "./by-id/index.js";
import { Router } from "express";

const bucketRouter = Router({ mergeParams: true });

bucketRouter.use("/by-id", byIdRouter);

export default bucketRouter;
