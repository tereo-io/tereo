import { adminResetUserTotp, getUserTotpStatus } from "./controllers.js";
import { requirePermission } from "../../../../../../middleware/auth.js";
import { Router } from "express";

const totpRouter = Router({ mergeParams: true });

totpRouter.post("/reset", requirePermission("users.write"), adminResetUserTotp);

totpRouter.get("/", requirePermission("users.read"), getUserTotpStatus);

export default totpRouter;
