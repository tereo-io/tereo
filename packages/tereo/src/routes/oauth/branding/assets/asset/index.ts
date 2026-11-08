import { getAsset } from "./controllers.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.get("/", getAsset);

export default router;
