import { requirePermission } from "../../../../../../middleware/auth.js";
import { listUserReports } from "./controllers.js";
import { Router } from "express";

const reportsRouter = Router({ mergeParams: true });

reportsRouter.get("/", requirePermission("users.read"), listUserReports);

export default reportsRouter;
