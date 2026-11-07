import { requirePermission } from "../../../../middleware/auth.js";
import { listBranding } from "./controllers.js";
import clientsRouter from "./clients/index.js";
import defaultRouter from "./default/index.js";
import { Router } from "express";

const brandingRouter = Router();

brandingRouter.use("/clients", clientsRouter);
brandingRouter.use("/default", defaultRouter);

brandingRouter.get("/", requirePermission("branding.read"), listBranding);

export default brandingRouter;
