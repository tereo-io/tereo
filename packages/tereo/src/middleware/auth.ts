import { setAuthSpanAttrs, setRequiredPermission } from "../utils/otel.js";
import { bearerToken, verifyAccessToken } from "../utils/tokens.js";
import { UserType } from "../../prisma/generated/client/index.js";
import type { Request, Response, NextFunction } from "express";
import type { CoreArea } from "../definitions/index.js";
import { hasPermission } from "../utils/permissions.js";
import { checkAccessToken } from "../utils/sessions.js";
import { clearAuthCookies } from "../utils/cookies.js";
import db from "../utils/db/index.js";
import {
  allowsArea,
  effectivePermissions,
  scopesForArea,
} from "../utils/coreAccess.js";
import {
  AppError,
  ForbiddenError,
  InvalidTokenError,
} from "../utils/errors.js";

export interface AuthContext {
  userId: string;
  email: string;
  name: string | null;
  userType: UserType;
  /** The user's live permissions, cut down to `ceiling` when there is one. */
  permissions: string[];
  /**
   * For a token delegated by core API scopes, the most its scopes allow.
   * Authority that does not come from permissions (an organization member
   * role) is capped by it too. Absent for full access.
   */
  ceiling?: string[];
  currentSessionId: string | null;
  /** The access token's own id. */
  jti: string;
  /** The client the token was issued to (its client_id). */
  clientId: string;
  /** The user's own client when the user is a service account; not the token's. */
  oauthClientId: string | null;
  organizationId: string | null;
  /** When the user signed in, from the token's `auth_time`; null when it has none. */
  authTime: Date | null;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export interface PublicRoute {
  /** Matched against `req.path` — the path relative to where the router
   * using this middleware is mounted, without the query string. */
  pattern: RegExp;
  /** Methods admitted without a token. Default: GET, HEAD. */
  methods?: string[];
}

export interface RequireAuthOptions {
  /** The part of core's API the router serves, which a delegated token's
   * scopes must name (utils/coreAccess.ts). */
  area: CoreArea;
  /** Routes admitted without a token. Admission only — each controller still
   * decides whether to serve an anonymous caller. */
  publicRoutes?: PublicRoute[];
}

/**
 * Build a `requireAuth` middleware. Every module authenticates through this —
 * tokens are verified in-process (signature, `jti` revocation, client and
 * session checks, permissions from the database), with no introspection hop.
 *
 * Core's API admits a token issued to core's UI or to a service with the
 * user's full rights. A token issued to any other client is admitted only
 * with core in its audience — it was granted core API scopes — and only to
 * the areas those scopes name (else 403 `insufficient_scope`), its
 * permissions cut down to their ceilings. Without core in its audience it is
 * refused with 401 `invalid_token`.
 */
export const createRequireAuth =
  (options: RequireAuthOptions) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader && options.publicRoutes?.length) {
      const isPublic = options.publicRoutes.some(
        (route) =>
          (route.methods ?? ["GET", "HEAD"]).includes(req.method) &&
          route.pattern.test(req.path)
      );
      if (isPublic) return next();
    }

    const token = bearerToken(authHeader);
    if (!token) throw new InvalidTokenError("Bearer token required");

    await authenticate(token, options.area, req, res);
    next();
  };

const authenticate = async (
  token: string,
  area: CoreArea,
  req: Request,
  res: Response
) => {
  const payload = verifyAccessToken(token);
  if (!payload) {
    throw new InvalidTokenError("Invalid or expired access token");
  }

  const check = await checkAccessToken(payload.jti, payload.client_id);
  if (!check.active) {
    if (check.clearCookies) {
      clearAuthCookies(
        res,
        check.clearCookies.reason,
        check.clearCookies.clientId
      );
    }
    throw new InvalidTokenError(check.reason);
  }
  // Every stored token names a user. A client_credentials token names the
  // client's service-account user — the identity the client acts as.
  const { token: storedToken, user, isClientToken, access } = check;

  if (access.kind === "none") {
    res.set("WWW-Authenticate", 'Bearer error="invalid_token"');
    throw new InvalidTokenError("This token is not issued for core's API");
  }
  if (!allowsArea(access, area)) {
    const scopes = scopesForArea(area).join(" ");
    res.set(
      "WWW-Authenticate",
      `Bearer error="insufficient_scope", scope="${scopes}"`
    );
    throw new AppError(
      403,
      "insufficient_scope",
      scopes
        ? `This token's scopes do not reach /${area}; it needs one of: ${scopes}`
        : `Only core's UI and services may call /${area}`
    );
  }

  const permissions = effectivePermissions(
    await db.roles.getUserPermissions(
      user.id,
      storedToken.organizationId ?? undefined
    ),
    access
  );

  req.auth = {
    userId: user.id,
    email: user.email,
    name: user.name,
    userType: user.userType,
    permissions,
    ...(access.kind === "delegated" && {
      ceiling: access.scopes.flatMap((s) => s.ceiling),
    }),
    currentSessionId: isClientToken ? null : storedToken.refreshTokenId,
    jti: payload.jti,
    clientId: payload.client_id,
    oauthClientId: user.oauthClientId,
    organizationId: storedToken.organizationId ?? null,
    authTime:
      payload.auth_time === undefined
        ? null
        : new Date(payload.auth_time * 1000),
  };

  setAuthSpanAttrs(req.auth);
};

/**
 * Returns `req.auth`, or throws if the request is unauthenticated. For
 * controllers behind `requireAuth` (or a public route that requires a user),
 * where a missing token gets the same 401 `requireAuth` would have given.
 */
export const validateUser = (req: Request): AuthContext => {
  if (!req.auth) throw new InvalidTokenError("Bearer token required");
  return req.auth;
};

export const requirePermission =
  (permission: string) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const user = validateUser(req);

    setRequiredPermission(permission);

    const hasRequiredPermission = hasPermission(user.permissions, permission);
    if (!hasRequiredPermission) {
      throw new ForbiddenError(
        `The following permission is required: ${permission}`
      );
    }

    next();
  };
