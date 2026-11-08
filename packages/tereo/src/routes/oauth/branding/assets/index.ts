import assetRouter from "./asset/index.js";
import { Router } from "express";
import helmet from "helmet";

const router = Router();

// Relaxed so a UI on another origin (the Vite dev server, or one hosted apart
// from core) can load the images.
router.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
router.use("/:file", assetRouter);

export default router;
