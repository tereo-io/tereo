import { requirePermission } from "../../../../../../middleware/auth.js";
import { deleteReportsTo, putReportsTo } from "./controllers.js";
import { Router } from "express";

const reportsToRouter = Router({ mergeParams: true });

reportsToRouter.put(
  "/",
  requirePermission("users.reports.write"),
  putReportsTo
);
reportsToRouter.delete(
  "/",
  requirePermission("users.reports.write"),
  deleteReportsTo
);

export default reportsToRouter;
