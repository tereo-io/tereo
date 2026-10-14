import { PERMISSIONS } from "../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import { createConnection, listConnections } from "./controllers.js";
import connectionRouter from "./connection/index.js";
import { Router } from "express";

const { READ, ADMIN } = PERMISSIONS.NOTIFICATIONS;

const connectionsRouter = Router();

connectionsRouter.use("/:id", connectionRouter);

connectionsRouter.get("/", requirePermission(READ), listConnections);
connectionsRouter.post("/", requirePermission(ADMIN), createConnection);

export default connectionsRouter;
