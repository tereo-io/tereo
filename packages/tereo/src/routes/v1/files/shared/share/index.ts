import fileRouter from "./file/index.js";
import { Router } from "express";
import {
  getShareViaToken,
  probeShareViaToken,
  unlockShare,
} from "./controllers.js";

const shareRouter = Router({ mergeParams: true });

shareRouter.post("/unlock", unlockShare);

// The trailing segment is cosmetic: it's how custom URL filenames are
// surfaced to end users.
shareRouter.use("/:filename", fileRouter);

// HEAD before GET: Express otherwise answers HEAD with the GET handler.
shareRouter.head("/", probeShareViaToken);
shareRouter.get("/", getShareViaToken);

export default shareRouter;
