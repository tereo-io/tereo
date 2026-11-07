import assetRouter from "./asset/index.js";
import { Router } from "express";

const router = Router();

router.use("/:file", assetRouter);

export default router;
