import type { NextFunction, Request, Response } from "express";
import { isReservedPath } from "../utils/ui.js";
import { logger } from "../utils/logger.js";
import { existsSync } from "fs";
import env from "../env.js";
import path from "path";

/**
 * The admin UI's build, or null when it is absent — core run from source
 * without building the UI serves the API alone.
 */
export const uiBuild = (() => {
  const distPath = env.UI_DIST_PATH;
  const indexHtml = path.join(distPath, "index.html");
  if (!existsSync(indexHtml)) {
    logger.info({ distPath }, "Admin UI build not found; not serving it");
    return null;
  }
  logger.info({ distPath }, "Serving the admin UI");
  return { distPath, indexHtml };
})();

/**
 * The app shell for any browser navigation outside core's reserved prefixes.
 * Anything under one — an unknown API path, a missing hashed asset — stays a
 * 404 rather than HTML a client would try to parse or run.
 */
export const serveAppShell = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!uiBuild) return next();
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (isReservedPath(req.path)) return next();
  if (req.accepts(["json", "html"]) !== "html") return next();
  res.setHeader("Cache-Control", "no-cache");
  // Relative to `root`, so a dot-directory above the build (a worktree under
  // `.claude/`) doesn't trip send's dotfile check.
  res.sendFile(
    "index.html",
    { root: uiBuild.distPath, cacheControl: false },
    (err) => {
      if (err) next(err);
    }
  );
};
