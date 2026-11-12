import { smallBodyParsers } from "../middleware/bodyParsers.js";
import { limitBrandedShell, uiFiles } from "./middleware.js";
import wellKnownRouter from "./well-known/index.js";
import { serveAppShell } from "./controllers.js";
import healthRouter from "./health/index.js";
import oauthRouter from "./oauth/index.js";
import scimRouter from "./scim/index.js";
import v1Router from "./v1/index.js";
import { Router } from "express";

/**
 * Core's URL tree. Core's own API is versioned under /v1; the protocol
 * endpoints and /health stay at the root — the issuer, discovery and the
 * `/oauth`-scoped cookies depend on their paths.
 */
const router = Router();

router.use("/.well-known", ...smallBodyParsers, wellKnownRouter);
router.use("/health", healthRouter);
router.use("/oauth", ...smallBodyParsers, oauthRouter);
router.use("/scim", scimRouter);
router.use("/v1", v1Router);

// The admin UI takes whatever is left, so it comes last: its files, then the
// app shell for client-side routes.
router.use(uiFiles);
router.use(limitBrandedShell, serveAppShell);

export default router;
