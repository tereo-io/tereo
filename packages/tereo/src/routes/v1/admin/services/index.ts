import { requirePermission } from "../../../../middleware/auth.js";
import serviceRouter from "./service/index.js";
import { Router } from "express";
import {
  createService,
  listServiceAccess,
  listServices,
} from "./controllers.js";

const servicesRouter = Router();

servicesRouter.get(
  "/access",
  requirePermission("services.read"),
  listServiceAccess
);

servicesRouter.use("/:id", serviceRouter);

servicesRouter.get("/", requirePermission("services.read"), listServices);
servicesRouter.post("/", requirePermission("services.write"), createService);

export default servicesRouter;
