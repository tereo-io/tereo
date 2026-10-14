import type { NextFunction, Request, Response } from "express";
import { hasCredentialCookie } from "../utils/cookies.js";
import { OAuth2Error } from "../utils/errors.js";
import env from "../env.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Core's own origin, the UI's, and the CORS allowlist; null for any. */
const allowedOrigins = (): Set<string> | null =>
  env.CORS_ALLOWED_ORIGINS === "*"
    ? null
    : new Set([
        new URL(env.PUBLIC_URL).origin,
        new URL(env.UI_BASE_URL).origin,
        ...env.CORS_ALLOWED_ORIGINS,
      ]);

const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin || origin === "null") return false;
  const allowed = allowedOrigins();
  return allowed === null || allowed.has(origin);
};

/**
 * Whether a state-changing request may act on the browser's cookies. The
 * cookies are SameSite=Lax, so a cross-site page cannot send them, but a
 * same-site one can (another port or subdomain): only core, the UI and the
 * CORS allowlist may. `Sec-Fetch-Site` decides when the browser sends it,
 * otherwise `Origin`; a request with neither is not from a browser page.
 */
const isAllowedCookieRequest = (req: Request): boolean => {
  const site = req.get("sec-fetch-site");
  const origin = req.get("origin");
  if (site !== undefined) {
    if (site === "same-origin") return true;
    return site === "same-site" && isAllowedOrigin(origin);
  }
  if (origin !== undefined) return isAllowedOrigin(origin);
  return true;
};

/**
 * Refuses a cookie-authenticated POST (or other unsafe method) from a page
 * that is not core, the UI or an allowed origin: login, consent, org
 * selection, 2FA, refresh by cookie, revoke and sign-out confirmation. A
 * request carrying none of core's credential cookies authenticates some
 * other way (a client secret, a code, a bearer token) and is not checked.
 */
export const requireAllowedOriginForCookies = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (
    SAFE_METHODS.has(req.method) ||
    !hasCredentialCookie(req) ||
    isAllowedCookieRequest(req)
  ) {
    next();
    return;
  }
  next(
    new OAuth2Error(
      "access_denied",
      "Cross-origin request refused: this origin may not act on the browser's session",
      403
    )
  );
};
