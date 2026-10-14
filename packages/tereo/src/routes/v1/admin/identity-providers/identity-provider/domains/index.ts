import { requirePermission } from "../../../../../../middleware/auth.js";
import { createDomain, listDomains } from "./controllers.js";
import domainRouter from "./domain/index.js";
import { Router } from "express";

const domainsRouter = Router({ mergeParams: true });

domainsRouter.use("/:domainId", domainRouter);

domainsRouter.get(
  "/",
  requirePermission("identity-providers.read"),
  listDomains
);
domainsRouter.post(
  "/",
  requirePermission("identity-providers.write"),
  createDomain
);

export default domainsRouter;
