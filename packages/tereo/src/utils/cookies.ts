import type { CookieOptions, Request, Response } from "express";
import { OAuth2Error } from "./errors.js";
import { logger } from "./logger.js";
import env from "../env.js";

const REFRESH_TOKEN_COOKIE_NAME = "trt";
const SESSION_INDICATOR_COOKIE_NAME = "tsi";
const CONSENT_SESSION_COOKIE_NAME = "tereo_consent_session";
const USER_SESSION_COOKIE_NAME = "tereo_user_session";
const TOTP_SESSION_COOKIE_NAME = "tereo_2fa_session";
const TOTP_SETUP_GRANT_COOKIE_NAME = "tereo_2fa_setup_grant";
const ORG_SELECT_SESSION_COOKIE_NAME = "tereo_org_select_session";
const LOGOUT_CONFIRM_COOKIE_NAME = "tereo_logout_confirm";
const SESSION_COOKIE_NAME = "tereo_session";
const IDENTITY_LINK_GRANT_COOKIE_NAME = "tereo_identity_link_grant";
// One per browser, not per client: it vouches for the browser, not a session.
const KNOWN_DEVICE_COOKIE_NAME = "tereo_known_device";
// The state of one round trip to an identity provider. One per browser, not
// per client; Lax so it survives the provider's top-level redirect back.
const UPSTREAM_AUTH_COOKIE_NAME = "tereo_upstream_auth";
const UPSTREAM_AUTH_PATH = "/oauth/upstream";
export const UPSTREAM_AUTH_TTL_SECONDS = 600;

// The cookies named `{base}_{client_id}`, each acting for that client.
const CLIENT_COOKIE_BASES = [
  REFRESH_TOKEN_COOKIE_NAME,
  CONSENT_SESSION_COOKIE_NAME,
  USER_SESSION_COOKIE_NAME,
  TOTP_SESSION_COOKIE_NAME,
  TOTP_SETUP_GRANT_COOKIE_NAME,
  ORG_SELECT_SESSION_COOKIE_NAME,
  LOGOUT_CONFIRM_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  IDENTITY_LINK_GRANT_COOKIE_NAME,
];

/**
 * Whether credential cookies are `__Host-` cookies: Secure, `Path=/`, no
 * Domain. The browser then refuses one set over http or by a sibling
 * subdomain, so no other host can plant or shadow them. `COOKIE_DOMAIN`
 * shares them with every subdomain instead, which the prefix forbids.
 */
export const usesHostPrefix = (
  secure: boolean,
  domain: string | undefined
): boolean => secure && !domain;

const HOST_PREFIX = usesHostPrefix(env.COOKIE_SECURE, env.COOKIE_DOMAIN)
  ? "__Host-"
  : "";

const credentialName = (base: string) => `${HOST_PREFIX}${base}`;
const clientCookieName = (base: string, clientId: string) =>
  credentialName(`${base}_${clientId}`);

// `path` is where an unprefixed cookie is scoped; a `__Host-` one must be `/`.
const credentialOptions = (
  maxAgeSeconds?: number,
  path = "/oauth"
): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: "lax",
  path: HOST_PREFIX ? "/" : path,
  domain: env.COOKIE_DOMAIN,
  ...(maxAgeSeconds !== undefined && { maxAge: maxAgeSeconds * 1000 }),
});

// Per request: the clients whose cookies the request's origin may use. Set
// by `requireAllowedOriginForCookies` only for an unsafe request from an
// origin that is neither core nor the UI; absent, any client's may be used.
const cookieClientsAllowed = new WeakMap<Request, ReadonlySet<string>>();

export const restrictCookieClients = (
  req: Request,
  clientIds: ReadonlySet<string>
): void => {
  cookieClientsAllowed.set(req, clientIds);
};

/**
 * A client's cookie, if it is a string: cookie-parser turns a `j:` value
 * into an object. Refuses a request whose origin may not act for the client.
 */
const readClientCookie = (
  req: Request,
  base: string,
  clientId: string
): string | undefined => {
  const value: unknown = req.cookies?.[clientCookieName(base, clientId)];
  if (typeof value !== "string" || !value) return undefined;
  const allowed = cookieClientsAllowed.get(req);
  if (allowed && !allowed.has(clientId)) {
    throw new OAuth2Error(
      "access_denied",
      "Cross-origin request refused: this origin may not act on this client's session",
      403
    );
  }
  return value;
};

const readBrowserCookie = (req: Request, name: string): string | undefined => {
  const value: unknown = req.cookies?.[credentialName(name)];
  return typeof value === "string" && value ? value : undefined;
};

/**
 * Whether the request carries any of core's credential cookies (a refresh
 * token, an SSO or login-flow session, a logout confirmation) — the
 * session indicator alone carries nothing.
 */
export const hasCredentialCookie = (req: Request): boolean => {
  const prefixes = [`${REFRESH_TOKEN_COOKIE_NAME}_`, "tereo_"].map(
    credentialName
  );
  return Object.keys(req.cookies ?? {}).some((name) =>
    prefixes.some((prefix) => name.startsWith(prefix))
  );
};

/** The client ids the request's per-client credential cookies name. */
export const credentialCookieClientIds = (req: Request): string[] => {
  const ids = new Set<string>();
  for (const name of Object.keys(req.cookies ?? {})) {
    for (const base of CLIENT_COOKIE_BASES) {
      const prefix = credentialName(`${base}_`);
      if (name.startsWith(prefix) && name.length > prefix.length) {
        ids.add(name.slice(prefix.length));
      }
    }
  }
  return [...ids];
};

/**
 * The refresh token's cookie, for the rest of its family's life (a rotated
 * token keeps the family's expiry), and the session indicator the UI reads
 * to tell whether a refresh is worth trying.
 */
export const setAuthCookies = (
  res: Response,
  refreshToken: string,
  clientId: string,
  expiresAt: Date
) => {
  const maxAge = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  );
  res.cookie(
    clientCookieName(REFRESH_TOKEN_COOKIE_NAME, clientId),
    refreshToken,
    credentialOptions(maxAge)
  );
  res.cookie(`${SESSION_INDICATOR_COOKIE_NAME}_${clientId}`, "1", {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    domain: env.COOKIE_DOMAIN,
    maxAge: maxAge * 1000,
    path: "/",
  });
};

export const clearAuthCookies = (
  res: Response,
  reason: string,
  clientId: string
) => {
  logger.debug(
    {
      reason,
      clientId,
      cookieDomain: env.COOKIE_DOMAIN,
      timestamp: new Date().toISOString(),
    },
    "Clearing auth cookies"
  );

  res.clearCookie(
    clientCookieName(REFRESH_TOKEN_COOKIE_NAME, clientId),
    credentialOptions()
  );
  res.clearCookie(`${SESSION_INDICATOR_COOKIE_NAME}_${clientId}`, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    domain: env.COOKIE_DOMAIN,
    path: "/",
  });
};

export const getRefreshTokenFromCookie = (
  req: Request,
  clientId: string
): string | undefined =>
  readClientCookie(req, REFRESH_TOKEN_COOKIE_NAME, clientId);

export const hasRefreshTokenCookie = (
  req: Request,
  clientId: string
): boolean => !!getRefreshTokenFromCookie(req, clientId);

const setClientCookie = (
  res: Response,
  base: string,
  clientId: string,
  value: string,
  maxAgeSeconds: number
) => {
  res.cookie(
    clientCookieName(base, clientId),
    value,
    credentialOptions(maxAgeSeconds)
  );
};

const clearClientCookie = (res: Response, base: string, clientId: string) => {
  res.clearCookie(clientCookieName(base, clientId), credentialOptions());
};

export const setConsentSessionCookie = (
  res: Response,
  sessionToken: string,
  clientId: string
) =>
  setClientCookie(
    res,
    CONSENT_SESSION_COOKIE_NAME,
    clientId,
    sessionToken,
    env.LOGIN_FLOW_TTL
  );

export const clearConsentSessionCookie = (res: Response, clientId: string) =>
  clearClientCookie(res, CONSENT_SESSION_COOKIE_NAME, clientId);

export const getConsentSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined =>
  readClientCookie(req, CONSENT_SESSION_COOKIE_NAME, clientId);

export const setUserSessionCookie = (
  res: Response,
  sessionToken: string,
  maxAge: number,
  clientId: string
) =>
  setClientCookie(
    res,
    USER_SESSION_COOKIE_NAME,
    clientId,
    sessionToken,
    maxAge
  );

export const clearUserSessionCookie = (res: Response, clientId: string) =>
  clearClientCookie(res, USER_SESSION_COOKIE_NAME, clientId);

export const getUserSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined =>
  readClientCookie(req, USER_SESSION_COOKIE_NAME, clientId);

export const setTotpSessionCookie = (
  res: Response,
  sessionToken: string,
  clientId: string
) =>
  setClientCookie(
    res,
    TOTP_SESSION_COOKIE_NAME,
    clientId,
    sessionToken,
    env.TOTP_VERIFICATION_TTL
  );

export const clearTotpSessionCookie = (res: Response, clientId: string) =>
  clearClientCookie(res, TOTP_SESSION_COOKIE_NAME, clientId);

export const getTotpSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined =>
  readClientCookie(req, TOTP_SESSION_COOKIE_NAME, clientId);

export const setTotpSetupGrantCookie = (
  res: Response,
  grant: string,
  clientId: string
) =>
  setClientCookie(
    res,
    TOTP_SETUP_GRANT_COOKIE_NAME,
    clientId,
    grant,
    env.TOTP_VERIFICATION_TTL
  );

export const clearTotpSetupGrantCookie = (res: Response, clientId: string) =>
  clearClientCookie(res, TOTP_SETUP_GRANT_COOKIE_NAME, clientId);

export const getTotpSetupGrantFromCookie = (
  req: Request,
  clientId: string
): string | undefined =>
  readClientCookie(req, TOTP_SETUP_GRANT_COOKIE_NAME, clientId);

export const setOrgSelectSessionCookie = (
  res: Response,
  sessionToken: string,
  clientId: string
) =>
  setClientCookie(
    res,
    ORG_SELECT_SESSION_COOKIE_NAME,
    clientId,
    sessionToken,
    env.LOGIN_FLOW_TTL
  );

export const clearOrgSelectSessionCookie = (res: Response, clientId: string) =>
  clearClientCookie(res, ORG_SELECT_SESSION_COOKIE_NAME, clientId);

export const getOrgSelectSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined =>
  readClientCookie(req, ORG_SELECT_SESSION_COOKIE_NAME, clientId);

// The authorize flow's session, from /oauth/authorize to the login submit.
export const setAuthSessionCookie = (
  res: Response,
  sessionId: string,
  clientId: string
) =>
  setClientCookie(
    res,
    SESSION_COOKIE_NAME,
    clientId,
    sessionId,
    env.LOGIN_FLOW_TTL
  );

export const clearAuthSessionCookie = (res: Response, clientId: string) =>
  clearClientCookie(res, SESSION_COOKIE_NAME, clientId);

export const getAuthSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined => readClientCookie(req, SESSION_COOKIE_NAME, clientId);

// How long a sign-out confirmation page stays usable: a person reads it.
const LOGOUT_CONFIRM_TTL_SECONDS = 600;

// Logout confirmation: the token the confirm page must send back, so only a
// request from this browser, carrying what core gave it, ends the session.
export const setLogoutConfirmCookie = (
  res: Response,
  token: string,
  clientId: string
) =>
  setClientCookie(
    res,
    LOGOUT_CONFIRM_COOKIE_NAME,
    clientId,
    token,
    LOGOUT_CONFIRM_TTL_SECONDS
  );

const clearLogoutConfirmCookie = (res: Response, clientId: string) =>
  clearClientCookie(res, LOGOUT_CONFIRM_COOKIE_NAME, clientId);

export const getLogoutConfirmFromCookie = (
  req: Request,
  clientId: string
): string | undefined =>
  readClientCookie(req, LOGOUT_CONFIRM_COOKIE_NAME, clientId);

// Known-device cookie (utils/knownDevice.ts). Not a session, so sign-out
// leaves it; a password change makes it stop matching.
export const setKnownDeviceCookie = (
  res: Response,
  token: string,
  maxAgeSeconds: number
) => {
  res.cookie(
    credentialName(KNOWN_DEVICE_COOKIE_NAME),
    token,
    credentialOptions(maxAgeSeconds)
  );
};

export const getKnownDeviceFromCookie = (req: Request): string | undefined =>
  readBrowserCookie(req, KNOWN_DEVICE_COOKIE_NAME);

export const clearAllSessionCookies = (res: Response, clientId: string) => {
  clearUserSessionCookie(res, clientId);
  clearConsentSessionCookie(res, clientId);
  clearTotpSessionCookie(res, clientId);
  clearTotpSetupGrantCookie(res, clientId);
  clearOrgSelectSessionCookie(res, clientId);
  clearAuthSessionCookie(res, clientId);
  clearLogoutConfirmCookie(res, clientId);
  clearIdentityLinkGrantCookie(res, clientId);
};

export const setUpstreamAuthCookie = (res: Response, state: string) => {
  res.cookie(
    credentialName(UPSTREAM_AUTH_COOKIE_NAME),
    state,
    credentialOptions(UPSTREAM_AUTH_TTL_SECONDS, UPSTREAM_AUTH_PATH)
  );
};

export const getUpstreamAuthFromCookie = (req: Request): string | undefined =>
  readBrowserCookie(req, UPSTREAM_AUTH_COOKIE_NAME);

export const clearUpstreamAuthCookie = (res: Response) => {
  res.clearCookie(
    credentialName(UPSTREAM_AUTH_COOKIE_NAME),
    credentialOptions(undefined, UPSTREAM_AUTH_PATH)
  );
};

// The link grant of an SSO-only user's correct password; it binds the grant to
// the browser that entered the password, as the TOTP setup grant does.
export const setIdentityLinkGrantCookie = (
  res: Response,
  grant: string,
  clientId: string
) =>
  setClientCookie(
    res,
    IDENTITY_LINK_GRANT_COOKIE_NAME,
    clientId,
    grant,
    env.TOTP_VERIFICATION_TTL
  );

export const getIdentityLinkGrantFromCookie = (
  req: Request,
  clientId: string
): string | undefined =>
  readClientCookie(req, IDENTITY_LINK_GRANT_COOKIE_NAME, clientId);

export const clearIdentityLinkGrantCookie = (res: Response, clientId: string) =>
  clearClientCookie(res, IDENTITY_LINK_GRANT_COOKIE_NAME, clientId);
