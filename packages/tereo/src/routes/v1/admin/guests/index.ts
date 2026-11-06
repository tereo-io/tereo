import { requirePermission } from "../../../../middleware/auth.js";
import { inviteGuest, listGuests } from "./controllers.js";
import optionsRouter from "./options/index.js";
import guestRouter from "./guest/index.js";
import { Router } from "express";

const guestsRouter = Router();

guestsRouter.use("/options", optionsRouter);
guestsRouter.use("/:id", guestRouter);

guestsRouter.get("/", requirePermission("users.guests.read"), listGuests);
guestsRouter.post("/", requirePermission("users.guests.write"), inviteGuest);

export default guestsRouter;
