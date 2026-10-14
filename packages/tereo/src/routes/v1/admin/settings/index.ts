import { requirePermission } from "../../../../middleware/auth.js";
import { getSettings, updateSettings } from "./controllers.js";
import { Router } from "express";

const settingsRouter = Router();

settingsRouter.get("/", requirePermission("settings.read"), getSettings);
settingsRouter.patch("/", requirePermission("settings.write"), updateSettings);

export default settingsRouter;
