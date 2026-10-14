import { uploadPhoto, deletePhoto } from "./controllers.js";
import { handleMulterErrors } from "./middleware.js";
import { Router } from "express";

const photoRouter = Router();

photoRouter.post("/", handleMulterErrors, uploadPhoto);
photoRouter.delete("/", deletePhoto);

export default photoRouter;
