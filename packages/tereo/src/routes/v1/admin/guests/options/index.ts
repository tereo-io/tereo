import { requirePermission } from "../../../../../middleware/auth.js";
import { getGuestOptions } from "./controllers.js";
import { Router } from "express";

const optionsRouter = Router();

optionsRouter.get(
  "/",
  requirePermission("users.guests.write"),
  getGuestOptions
);

export default optionsRouter;
