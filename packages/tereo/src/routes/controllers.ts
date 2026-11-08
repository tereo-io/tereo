import type { NextFunction, Request, Response } from "express";
import { createAppShell } from "./appShell.js";
import { existsSync, readFileSync } from "fs";
import { logger } from "../utils/logger.js";
import env from "../env.js";
import path from "path";
import {
  resolveBranding,
  resolveConsoleBranding,
} from "../utils/branding/resolve.js";

/**
 * The admin UI's build, or null when it is absent — core run from source
 * without building the UI serves the API alone.
 */
export const uiBuild = (() => {
  const distPath = env.UI_DIST_PATH;
  const indexPath = path.join(distPath, "index.html");
  if (!existsSync(indexPath)) {
    logger.info({ distPath }, "Admin UI build not found; not serving it");
    return null;
  }
  logger.info({ distPath }, "Serving the admin UI");
  return { distPath, indexHtml: readFileSync(indexPath, "utf8") };
})();

export const serveAppShell = uiBuild
  ? createAppShell({
      indexHtml: uiBuild.indexHtml,
      resolvers: { auth: resolveBranding, console: resolveConsoleBranding },
    })
  : (_req: Request, _res: Response, next: NextFunction) => next();
