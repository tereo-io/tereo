import type { NextFunction, Request, Response } from "express";
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
