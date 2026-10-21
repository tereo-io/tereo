import type { NextFunction, Request, Response } from "express";
import { httpOrigin } from "../utils/authorization.js";
import db from "../utils/db/index.js";
import env from "../env.js";
import {
  credentialCookieClientIds,
  hasCredentialCookie,
  restrictCookieClients,
} from "../utils/cookies.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// A browser sends at most this many cookies per host, near enough.
const MAX_COOKIE_CLIENTS = 50;

const FIRST_PARTY = Symbol("first-party");

const firstPartyOrigins = () =>
  new Set([new URL(env.PUBLIC_URL).origin, new URL(env.UI_BASE_URL).origin]);

/**
 * Who sent a state-changing request: `FIRST_PARTY` for core, the UI (which
 * hosts every client's login pages) and a request from no browser page
 * (neither `Sec-Fetch-Site` nor `Origin`); otherwise the page's origin, or
 * null when it may act on no cookie at all (cross-site, an opaque origin).
 */
const requestOrigin = (req: Request): typeof FIRST_PARTY | string | null => {
  const site = req.get("sec-fetch-site");
  const origin = req.get("origin");
  if (site === "same-origin") return FIRST_PARTY;
  if (site === undefined && origin === undefined) return FIRST_PARTY;
  if (site !== undefined && site !== "same-site") return null;
  if (!origin || origin === "null") return null;
  return firstPartyOrigins().has(origin) ? FIRST_PARTY : origin;
};

/**
 * Binds a cookie-authenticated POST (or other unsafe method) to the clients
 * its origin belongs to. The cookies are SameSite=Lax, so a cross-site page
 * cannot send them, but a same-site one can (another port or subdomain),
 * along with every other client's. Core and the UI may use any client's
 * cookies; another origin only those of a client with a redirect URI there,
 * so an app's page cannot refresh or end another client's session. The
 * cookie getters refuse the rest when a handler reads them
 * (`restrictCookieClients`); a request using none of them, authenticated by
 * a secret, a code or a token in the body, is not affected.
 */
export const requireAllowedOriginForCookies = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (SAFE_METHODS.has(req.method) || !hasCredentialCookie(req)) {
    next();
    return;
  }
  const origin = requestOrigin(req);
  if (origin === FIRST_PARTY) {
    next();
    return;
  }
  const allowed = new Set<string>();
  const clientIds = credentialCookieClientIds(req).slice(0, MAX_COOKIE_CLIENTS);
  if (origin !== null && clientIds.length > 0) {
    for (const client of await db.clients.getRedirectUris(clientIds)) {
      if (client.redirectUris.some((uri) => httpOrigin(uri) === origin)) {
        allowed.add(client.clientId);
      }
    }
  }
  restrictCookieClients(req, allowed);
  next();
};
