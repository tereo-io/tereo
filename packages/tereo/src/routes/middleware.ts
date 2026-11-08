import type { NextFunction, Request, Response } from "express";
import { rateLimitGeneral } from "../middleware/rateLimit.js";
import { isBrandedAuthPath } from "../utils/ui.js";
import { uiBuild } from "./controllers.js";
import express from "express";
import path from "path";

const passThrough = (_req: Request, _res: Response, next: NextFunction) =>
  next();

/**
 * The admin UI's build files, as they are. Vite puts content-hashed files
 * under assets/, cached for a year; everything else keeps its name across
 * builds and must be revalidated.
 */
const serveBuild = (distPath: string) => {
  const assetsDir = path.join(distPath, "assets") + path.sep;
  return express.static(distPath, {
    index: false,
    // A bare `/assets` would otherwise get an HTML redirect to `/assets/`.
    redirect: false,
    setHeaders: (res, filePath) => {
      res.setHeader(
        "Cache-Control",
        filePath.startsWith(assetsDir)
          ? "public, max-age=31536000, immutable"
          : "no-cache"
      );
    },
  });
};

export const uiFiles = uiBuild ? serveBuild(uiBuild.distPath) : passThrough;

/**
 * The general limiter on the branded sign-in pages, and only there: each one
 * resolves `?client_id=`, which anyone can vary to make core look it up.
 */
export const limitBrandedShell = (
  req: Request,
  res: Response,
  next: NextFunction
) =>
  (req.method === "GET" || req.method === "HEAD") && isBrandedAuthPath(req.path)
    ? rateLimitGeneral(req, res, next)
    : next();
