import { requirePermission } from "../../../../middleware/auth.js";
import { createClient, listClients } from "./controllers.js";
import clientRouter from "./client/index.js";
import { Router } from "express";

const clientsRouter = Router();

clientsRouter.use("/:id", clientRouter);

clientsRouter.get("/", requirePermission("clients.read"), listClients);
clientsRouter.post("/", requirePermission("clients.write"), createClient);

export default clientsRouter;
