import { getBranding } from "./controllers.js";
import assetsRouter from "./assets/index.js";
import { Router } from "express";

const router = Router();

router.use("/assets", assetsRouter);

router.get("/", getBranding);

export default router;
