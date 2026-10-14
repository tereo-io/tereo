import { orgSelectGetHandler, orgSelectSubmitHandler } from "./controllers.js";
import { Router } from "express";

const router = Router();

router.post("/submit", orgSelectSubmitHandler);
router.get("/", orgSelectGetHandler);

export default router;
