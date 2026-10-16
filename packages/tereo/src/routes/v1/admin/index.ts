import identityProvidersRouter from "./identity-providers/index.js";
import { createRequireAuth } from "../../../middleware/auth.js";
import notificationsRouter from "./notifications/index.js";
import organizationsRouter from "./organizations/index.js";
import integrationsRouter from "./integrations/index.js";
import signingKeysRouter from "./signing-keys/index.js";
import permissionsRouter from "./permissions/index.js";
import settingsRouter from "./settings/index.js";
import servicesRouter from "./services/index.js";
import clientsRouter from "./clients/index.js";
import usersRouter from "./users/index.js";
import rolesRouter from "./roles/index.js";
import { Router } from "express";
import {
  rateLimitGeneral,
  rateLimitPreAuth,
} from "../../../middleware/rateLimit.js";

const adminRouter = Router();

adminRouter.use(rateLimitPreAuth);
adminRouter.use(createRequireAuth({ area: "admin" }));
adminRouter.use(rateLimitGeneral);

adminRouter.use("/clients", clientsRouter);
adminRouter.use("/identity-providers", identityProvidersRouter);
adminRouter.use("/integrations", integrationsRouter);
adminRouter.use("/notifications", notificationsRouter);
adminRouter.use("/organizations", organizationsRouter);
adminRouter.use("/permissions", permissionsRouter);
adminRouter.use("/roles", rolesRouter);
adminRouter.use("/services", servicesRouter);
adminRouter.use("/settings", settingsRouter);
adminRouter.use("/signing-keys", signingKeysRouter);
adminRouter.use("/users", usersRouter);

export default adminRouter;
