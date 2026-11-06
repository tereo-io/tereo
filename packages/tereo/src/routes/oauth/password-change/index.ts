import { passwordChangeHandler } from "./controllers.js";
import { Router } from "express";

const router = Router();

router.post("/", passwordChangeHandler);

export default router;
