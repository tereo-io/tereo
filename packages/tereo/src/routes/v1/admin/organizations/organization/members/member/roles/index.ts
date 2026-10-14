import { getMemberOrgRoles, setMemberOrgRoles } from "./controllers.js";
import { Router } from "express";

const rolesRouter = Router({ mergeParams: true });

// Auth checked in controllers via requireOrgRole
rolesRouter.get("/", getMemberOrgRoles);
rolesRouter.put("/", setMemberOrgRoles);

export default rolesRouter;
