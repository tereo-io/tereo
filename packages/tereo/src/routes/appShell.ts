import type { EffectiveBranding } from "../utils/branding/merge.js";
import { isBrandedAuthPath, isReservedPath } from "../utils/ui.js";
import type { NextFunction, Request, Response } from "express";
import { injectBranding } from "../utils/branding/inject.js";
import { logger } from "../utils/logger.js";

export interface BrandingResolvers {
  auth: (clientId: unknown) => Promise<EffectiveBranding | null>;
  console: () => Promise<EffectiveBranding | null>;
}

const brandedShell = async (
  req: Request,
  indexHtml: string,
  resolvers: BrandingResolvers
): Promise<string> => {
  try {
    if (isBrandedAuthPath(req.path)) {
      const branding = await resolvers.auth(req.query.client_id);
      return injectBranding(indexHtml, branding, "auth");
    }
    const branding = await resolvers.console();
    return branding?.applyToConsole
      ? injectBranding(indexHtml, branding, "console")
      : indexHtml;
  } catch (err) {
    logger.error({ err }, "Branding resolve failed; serving the stock shell");
    return indexHtml;
  }
};

/**
 * The app shell for any browser navigation outside core's reserved prefixes.
 * Anything under one — an unknown API path, a missing hashed asset — stays a
 * 404 rather than HTML a client would try to parse or run.
 */
export const createAppShell =
  ({
    indexHtml,
    resolvers,
  }: {
    indexHtml: string;
    resolvers: BrandingResolvers;
  }) =>
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (isReservedPath(req.path)) return next();
    if (req.accepts(["json", "html"]) !== "html") return next();
    const html = await brandedShell(req, indexHtml, resolvers);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(html);
  };
