import { getSessions, revokeAllSessions } from "./controllers.js";
import sessionRouter from "./session/index.js";
import { Router } from "express";

const sessionsRouter = Router();

sessionsRouter.use("/:sessionId", sessionRouter);

sessionsRouter.get("/", getSessions);
sessionsRouter.delete("/", revokeAllSessions);

export default sessionsRouter;
