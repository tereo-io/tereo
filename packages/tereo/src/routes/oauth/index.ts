import { requireAllowedOriginForCookies } from "../../middleware/originCheck.js";
import { rateLimitGeneral } from "../../middleware/rateLimit.js";
import checkPermissionRouter from "./check-permission/index.js";
import endSessionRouter from "./end-session/index.js";
import introspectRouter from "./introspect/index.js";
import orgSelectRouter from "./org-select/index.js";
import authorizeRouter from "./authorize/index.js";
import userinfoRouter from "./userinfo/index.js";
import upstreamRouter from "./upstream/index.js";
import consentRouter from "./consent/index.js";
import revokeRouter from "./revoke/index.js";
import tokenRouter from "./token/index.js";
import { noStore } from "./middleware.js";
import totpRouter from "./totp/index.js";
import { Router } from "express";

const router = Router();

router.use(rateLimitGeneral);

// Core's credential cookies are scoped to /oauth, so every cookie-
// authenticated state change is under this router.
router.use(requireAllowedOriginForCookies);

router.use(noStore);

router.use("/authorize", authorizeRouter);
router.use("/check-permission", checkPermissionRouter);
router.use("/consent", consentRouter);
router.use("/end-session", endSessionRouter);
router.use("/introspect", introspectRouter);
router.use("/org-select", orgSelectRouter);
router.use("/revoke", revokeRouter);
router.use("/token", tokenRouter);
router.use("/totp", totpRouter);
router.use("/upstream", upstreamRouter);
router.use("/userinfo", userinfoRouter);

export default router;
