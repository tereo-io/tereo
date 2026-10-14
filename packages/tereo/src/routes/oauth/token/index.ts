import { tokenHandler } from "./controllers.js";
import { Router } from "express";

const tokenRouter = Router();

tokenRouter.post("/", tokenHandler);

export default tokenRouter;
