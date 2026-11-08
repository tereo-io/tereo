import { removeMember } from "./controllers.js";
import { Router } from "express";

const memberRouter = Router({ mergeParams: true });

memberRouter.delete("/", removeMember);

export default memberRouter;
