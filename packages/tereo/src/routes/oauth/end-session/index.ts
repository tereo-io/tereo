import { Router } from "express";
import {
  endSessionConfirmGetHandler,
  endSessionConfirmPostHandler,
  endSessionGetHandler,
  endSessionPostHandler,
} from "./controllers.js";

const endSessionRouter = Router();

endSessionRouter.get("/confirm", endSessionConfirmGetHandler);
endSessionRouter.post("/confirm", endSessionConfirmPostHandler);
endSessionRouter.get("/", endSessionGetHandler);
endSessionRouter.post("/", endSessionPostHandler);

export default endSessionRouter;
