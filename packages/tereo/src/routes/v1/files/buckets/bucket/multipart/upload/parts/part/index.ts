import { PERMISSIONS } from "../../../../../../../../../definitions/permissions.js";
import { requirePermission } from "../../../../../../../../../middleware/auth.js";
import { uploadPart } from "./controllers.js";
import { Router } from "express";

const partRouter = Router({ mergeParams: true });

partRouter.put("/", requirePermission(PERMISSIONS.objects.write), uploadPart);

export default partRouter;
