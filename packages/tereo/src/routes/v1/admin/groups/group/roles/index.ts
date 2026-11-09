import { listGroupRoles, setGroupRoles } from "./controllers.js";
import { Router } from "express";

const rolesRouter = Router({ mergeParams: true });

rolesRouter.get("/", listGroupRoles);
rolesRouter.put("/", setGroupRoles);

export default rolesRouter;
