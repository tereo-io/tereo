import entityTypeRouter from "./entity-type/index.js";
import { Router } from "express";

// One entity's history: /entries/entity/:entityType/:entityId.
const router = Router({ mergeParams: true });

router.use("/:entityType", entityTypeRouter);

export default router;
