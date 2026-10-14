import { requirePermission } from "../../../../middleware/auth.js";
import { createRole, listRoles } from "./controllers.js";
import roleRouter from "./role/index.js";
import { Router } from "express";

const rolesRouter = Router();

rolesRouter.use("/:id", roleRouter);

rolesRouter.get("/", requirePermission("roles.read"), listRoles);
rolesRouter.post("/", requirePermission("roles.write"), createRole);

export default rolesRouter;
