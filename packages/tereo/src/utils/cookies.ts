import type { Request, Response } from "express";
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
// One per browser, not per client: it vouches for the browser, not a session.
const KNOWN_DEVICE_COOKIE_NAME = "tereo_known_device";

const getRefreshTokenCookieName = (clientId: string) =>
  `${REFRESH_TOKEN_COOKIE_NAME}_${clientId}`;
const getSessionIndicatorCookieName = (clientId: string) =>
  `${SESSION_INDICATOR_COOKIE_NAME}_${clientId}`;
const getConsentSessionCookieName = (clientId: string) =>
  `${CONSENT_SESSION_COOKIE_NAME}_${clientId}`;
const getUserSessionCookieName = (clientId: string) =>
  `${USER_SESSION_COOKIE_NAME}_${clientId}`;
const getTotpSessionCookieName = (clientId: string) =>
  `${TOTP_SESSION_COOKIE_NAME}_${clientId}`;
const getTotpSetupGrantCookieName = (clientId: string) =>
  `${TOTP_SETUP_GRANT_COOKIE_NAME}_${clientId}`;
const getOrgSelectSessionCookieName = (clientId: string) =>
  `${ORG_SELECT_SESSION_COOKIE_NAME}_${clientId}`;
const getLogoutConfirmCookieName = (clientId: string) =>
  `${LOGOUT_CONFIRM_COOKIE_NAME}_${clientId}`;
const getAuthSessionCookieName = (clientId: string) =>
  `${SESSION_COOKIE_NAME}_${clientId}`;

// Auth cookies (refresh token + session indicator)
export const setAuthCookies = (
  res: Response,
  refreshToken: string,
  clientId: string
) => {
  res.cookie(getRefreshTokenCookieName(clientId), refreshToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    domain: env.COOKIE_DOMAIN,
    maxAge: env.JWT_REFRESH_TOKEN_TTL * 1000,
    path: "/oauth",
  });
  res.cookie(getSessionIndicatorCookieName(clientId), "1", {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    domain: env.COOKIE_DOMAIN,
    maxAge: env.JWT_REFRESH_TOKEN_TTL * 1000,
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

  res.clearCookie(getRefreshTokenCookieName(clientId), {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    domain: env.COOKIE_DOMAIN,
    path: "/oauth",
  });
  res.clearCookie(getSessionIndicatorCookieName(clientId), {
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
): string | undefined => {
  return req.cookies?.[getRefreshTokenCookieName(clientId)];
};

export const hasRefreshTokenCookie = (
  req: Request,
  clientId: string
): boolean => {
  return !!req.cookies?.[getRefreshTokenCookieName(clientId)];
};

const CREDENTIAL_COOKIE_PREFIXES = [`${REFRESH_TOKEN_COOKIE_NAME}_`, "tereo_"];

/**
 * Whether the request carries any of core's credential cookies (a refresh
 * token, an SSO or login-flow session, a logout confirmation) — the
 * session indicator alone carries nothing.
 */
export const hasCredentialCookie = (req: Request): boolean =>
  Object.keys(req.cookies ?? {}).some((name) =>
    CREDENTIAL_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );

// Consent session cookie
export const setConsentSessionCookie = (
  res: Response,
  sessionToken: string,
  clientId: string
) => {
  res.cookie(getConsentSessionCookieName(clientId), sessionToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: env.LOGIN_FLOW_TTL * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const clearConsentSessionCookie = (res: Response, clientId: string) => {
  res.clearCookie(getConsentSessionCookieName(clientId), {
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getConsentSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined => {
  return req.cookies?.[getConsentSessionCookieName(clientId)];
};

// User session cookie
export const setUserSessionCookie = (
  res: Response,
  sessionToken: string,
  maxAge: number,
  clientId: string
) => {
  res.cookie(getUserSessionCookieName(clientId), sessionToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: maxAge * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const clearUserSessionCookie = (res: Response, clientId: string) => {
  res.clearCookie(getUserSessionCookieName(clientId), {
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getUserSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined => {
  return req.cookies?.[getUserSessionCookieName(clientId)];
};

// TOTP session cookie
export const setTotpSessionCookie = (
  res: Response,
  sessionToken: string,
  clientId: string
) => {
  res.cookie(getTotpSessionCookieName(clientId), sessionToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: env.TOTP_VERIFICATION_TTL * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const clearTotpSessionCookie = (res: Response, clientId: string) => {
  res.clearCookie(getTotpSessionCookieName(clientId), {
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getTotpSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined => {
  return req.cookies?.[getTotpSessionCookieName(clientId)];
};

export const setTotpSetupGrantCookie = (
  res: Response,
  grant: string,
  clientId: string
) => {
  res.cookie(getTotpSetupGrantCookieName(clientId), grant, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: env.TOTP_VERIFICATION_TTL * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const clearTotpSetupGrantCookie = (res: Response, clientId: string) => {
  res.clearCookie(getTotpSetupGrantCookieName(clientId), {
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getTotpSetupGrantFromCookie = (
  req: Request,
  clientId: string
): string | undefined => {
  return req.cookies?.[getTotpSetupGrantCookieName(clientId)];
};

// Org selection session cookie
export const setOrgSelectSessionCookie = (
  res: Response,
  sessionToken: string,
  clientId: string
) => {
  res.cookie(getOrgSelectSessionCookieName(clientId), sessionToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: env.LOGIN_FLOW_TTL * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const clearOrgSelectSessionCookie = (
  res: Response,
  clientId: string
) => {
  res.clearCookie(getOrgSelectSessionCookieName(clientId), {
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getOrgSelectSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined => {
  return req.cookies?.[getOrgSelectSessionCookieName(clientId)];
};

// Auth session cookie (for authorize flow)
export const setAuthSessionCookie = (
  res: Response,
  sessionId: string,
  clientId: string
) => {
  res.cookie(getAuthSessionCookieName(clientId), sessionId, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: env.LOGIN_FLOW_TTL * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const clearAuthSessionCookie = (res: Response, clientId: string) => {
  res.clearCookie(getAuthSessionCookieName(clientId), {
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getAuthSessionFromCookie = (
  req: Request,
  clientId: string
): string | undefined => {
  return req.cookies?.[getAuthSessionCookieName(clientId)];
};

// How long a sign-out confirmation page stays usable: a person reads it.
const LOGOUT_CONFIRM_TTL_SECONDS = 600;

// Logout confirmation: the token the confirm page must send back, so only a
// request from this browser, carrying what core gave it, ends the session.
export const setLogoutConfirmCookie = (
  res: Response,
  token: string,
  clientId: string
) => {
  res.cookie(getLogoutConfirmCookieName(clientId), token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: LOGOUT_CONFIRM_TTL_SECONDS * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

const clearLogoutConfirmCookie = (res: Response, clientId: string) => {
  res.clearCookie(getLogoutConfirmCookieName(clientId), {
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getLogoutConfirmFromCookie = (
  req: Request,
  clientId: string
): string | undefined => {
  return req.cookies?.[getLogoutConfirmCookieName(clientId)];
};

// Known-device cookie (utils/knownDevice.ts). Not a session, so sign-out
// leaves it; a password change makes it stop matching.
export const setKnownDeviceCookie = (
  res: Response,
  token: string,
  maxAgeSeconds: number
) => {
  res.cookie(KNOWN_DEVICE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: maxAgeSeconds * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getKnownDeviceFromCookie = (req: Request): string | undefined => {
  const value = req.cookies?.[KNOWN_DEVICE_COOKIE_NAME];
  return typeof value === "string" ? value : undefined;
};

// Clear all session cookies (used during logout)
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

// Upstream sign-in: the state of one round trip to an identity provider.
// One per browser, not per client; Lax so it survives the provider's
// top-level redirect back.
const UPSTREAM_AUTH_COOKIE_NAME = "tereo_upstream_auth";
const UPSTREAM_AUTH_PATH = "/oauth/upstream";
export const UPSTREAM_AUTH_TTL_SECONDS = 600;

export const setUpstreamAuthCookie = (res: Response, state: string) => {
  res.cookie(UPSTREAM_AUTH_COOKIE_NAME, state, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: UPSTREAM_AUTH_TTL_SECONDS * 1000,
    path: UPSTREAM_AUTH_PATH,
    domain: env.COOKIE_DOMAIN,
  });
};

export const getUpstreamAuthFromCookie = (req: Request): string | undefined => {
  const value = req.cookies?.[UPSTREAM_AUTH_COOKIE_NAME];
  return typeof value === "string" ? value : undefined;
};

export const clearUpstreamAuthCookie = (res: Response) => {
  res.clearCookie(UPSTREAM_AUTH_COOKIE_NAME, {
    path: UPSTREAM_AUTH_PATH,
    domain: env.COOKIE_DOMAIN,
  });
};

// The link grant of an SSO-only user's correct password; it binds the grant to
// the browser that entered the password, as the TOTP setup grant does.
const IDENTITY_LINK_GRANT_COOKIE_NAME = "tereo_identity_link_grant";

const getIdentityLinkGrantCookieName = (clientId: string) =>
  `${IDENTITY_LINK_GRANT_COOKIE_NAME}_${clientId}`;

export const setIdentityLinkGrantCookie = (
  res: Response,
  grant: string,
  clientId: string
) => {
  res.cookie(getIdentityLinkGrantCookieName(clientId), grant, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: env.TOTP_VERIFICATION_TTL * 1000,
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};

export const getIdentityLinkGrantFromCookie = (
  req: Request,
  clientId: string
): string | undefined => {
  const value = req.cookies?.[getIdentityLinkGrantCookieName(clientId)];
  return typeof value === "string" ? value : undefined;
};

export const clearIdentityLinkGrantCookie = (
  res: Response,
  clientId: string
) => {
  res.clearCookie(getIdentityLinkGrantCookieName(clientId), {
    path: "/oauth",
    domain: env.COOKIE_DOMAIN,
  });
};
