import entityRouter from "./entity/index.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

router.use("/:entityId", entityRouter);

export default router;
