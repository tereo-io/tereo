import { createRequireAuth } from "../../../middleware/auth.js";
import { getProfile, changePassword } from "./controllers.js";
import identitiesRouter from "./identities/index.js";
import sessionsRouter from "./sessions/index.js";
import photoRouter from "./photo/index.js";
import totpRouter from "./totp/index.js";
import { Router } from "express";
import {
  rateLimitGeneral,
  rateLimitPreAuth,
} from "../../../middleware/rateLimit.js";

const accountRouter = Router();

accountRouter.use(rateLimitPreAuth);
accountRouter.use(createRequireAuth({ area: "account" }));
accountRouter.use(rateLimitGeneral);

accountRouter.use("/totp", totpRouter);
accountRouter.use("/photo", photoRouter);
accountRouter.use("/sessions", sessionsRouter);
accountRouter.use("/identities", identitiesRouter);

accountRouter.get("/me", getProfile);
accountRouter.post("/password", changePassword);

export default accountRouter;
