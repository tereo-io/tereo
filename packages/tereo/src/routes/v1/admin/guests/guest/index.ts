import { requirePermission } from "../../../../../middleware/auth.js";
import passwordSetupLinkRouter from "./password-setup-link/index.js";
import { getGuest, updateGuest } from "./controllers.js";
import { Router } from "express";

const guestRouter = Router({ mergeParams: true });

guestRouter.use("/password-setup-link", passwordSetupLinkRouter);

guestRouter.get("/", requirePermission("users.guests.read"), getGuest);
guestRouter.patch("/", requirePermission("users.guests.write"), updateGuest);

export default guestRouter;
