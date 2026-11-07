import clientRouter from "./client/index.js";
import { Router } from "express";

const clientsRouter = Router();

clientsRouter.use("/:id", clientRouter);

export default clientsRouter;
