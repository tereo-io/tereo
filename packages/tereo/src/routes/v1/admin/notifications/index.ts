import connectionsRouter from "./connections/index.js";
import channelsRouter from "./channels/index.js";
import logRouter from "./log/index.js";
import { Router } from "express";

const notificationsRouter = Router();

notificationsRouter.use("/channels", channelsRouter);
notificationsRouter.use("/connections", connectionsRouter);

// After the fixed segments, so /channels and /connections are never an :id.
notificationsRouter.use("/", logRouter);

export default notificationsRouter;
