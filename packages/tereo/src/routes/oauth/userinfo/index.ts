import { getUserInfo } from "./controllers.js";
import { Router } from "express";

const router = Router();

router.get("/", getUserInfo);
router.post("/", getUserInfo);

export default router;
