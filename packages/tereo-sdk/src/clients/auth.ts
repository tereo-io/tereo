import type { ActiveIntrospectionResponse } from "../requests/auth/oauth/types.js";
import { setAuthSpanAttrs, setRequiredPermission } from "../utils/otel.js";
import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";
import type { Request, Response, NextFunction } from "express";
import { getOriginalStatus, requests } from "../handler.js";
import { parseTestToken } from "../utils/testTokens.js";
import { hasPermission } from "../utils/permissions.js";
import { logger } from "../utils/logger.js";
import crypto from "crypto";
import {
  buildCachePrefix,
  safeCacheGet,
  safeCacheSet,
} from "../utils/cache.js";
import type {
  AuthContext,
  OrganizationContext,
  IntrospectionResponse,
  PublicRouteConfig,
  AuthServiceClientConfig,
  AuthServiceOrganization,
  AuthServiceOwnService,
  AuthServiceUser,
} from "../types/auth.js";

/**
 * Core sets a token's `sub` to the user it was issued for, or to the client's
 * own id for a client_credentials token. A session id is no guide: a person's
 * token minted without a refresh token has none.
 */
export const tokenUserType = (
  res: Pick<ActiveIntrospectionResponse, "sub" | "client_id">
): AuthContext["userType"] =>
  res.sub && res.sub !== res.client_id ? "human" : "service_account";

// Extend Express Request type to include auth and organization context
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      organization?: OrganizationContext;
    }
  }
}

/**
 * Cache prefix and TTLs. Entries are shared by a service's replicas only:
 * the cache scopes every key by the service's client id.
 */
const AUTH_CACHE_PREFIX = buildCachePrefix("auth-sdk");
const INTROSPECT_CACHE_TTL_SECONDS = 60;

/**
 * How long an active introspection may be cached: never past the token's
 * own `exp`, or an expired token would keep passing. 0 means not at all.
 */
export const introspectionCacheTtl = (exp: number, nowMs = Date.now()) =>
  Math.max(
    0,
    Math.min(INTROSPECT_CACHE_TTL_SECONDS, exp - Math.ceil(nowMs / 1000))
  );
const USER_CACHE_TTL_SECONDS = 300;
const USER_NOT_FOUND_CACHE_TTL_SECONDS = 60;
const MAX_USER_IDS_PER_REQUEST = 100;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AuthServiceClient {
  private readonly defaultTestPermissions: string[];
  private readonly publicRoutes: PublicRouteConfig[];

  /**
   * `testMode` accepts forged test tokens and answers user and organization
   * lookups with stubs. `createCoreClient` passes its own `testMode`.
   */
  constructor(
    config: AuthServiceClientConfig = {},
    private readonly testMode = false,
    private readonly testServiceUserId?: string
  ) {
    this.defaultTestPermissions = config.defaultTestPermissions ?? [];
    this.publicRoutes = config.publicRoutes ?? [];
  }

  /**
   * Introspect a Bearer token with core.
   * Results are cached in Redis by SHA-256 hash of the token.
   * In test mode (`createCoreClient({ testMode: true })`), accepts test tokens without calling core.
   */
  async introspectToken(token: string): Promise<IntrospectionResponse> {
    if (this.testMode) {
      const testResult = parseTestToken(token, this.defaultTestPermissions, {
        serviceUserId: this.testServiceUserId,
      });
      if (testResult) return testResult;
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const cacheKey = `${AUTH_CACHE_PREFIX}token:${tokenHash}`;

    const cached = await safeCacheGet<IntrospectionResponse>(cacheKey);
    if (cached) return cached;

    try {
      const data = await requests.auth.introspectToken(token);
      const ttl = data.active ? introspectionCacheTtl(data.exp) : 0;
      if (ttl > 0) await safeCacheSet(cacheKey, data, ttl);
      return data;
    } catch (err) {
      // Core down, a network blip, a 5xx: answered as an invalid token so the
      // caller gets a 401 rather than a 500, but logged, since every request
      // is being refused for a reason that is not the token.
      logger.error(
        { err },
        "Token introspection failed; treating the token as inactive"
      );
      return { active: false };
    }
  }

  /**
   * Get a user from core's admin API.
   * Results are cached in Redis. Returns null if the user is not found.
   * In test mode (`createCoreClient({ testMode: true })`), returns mock data for any UUID-shaped userId.
   */
  async getUser(userId: string): Promise<AuthServiceUser | null> {
    if (this.testMode) {
      return {
        id: userId,
        email: `test-user-${userId}@example.com`,
        name: `Test User ${userId}`,
        isActive: true,
        userType: "human",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const cacheKey = `${AUTH_CACHE_PREFIX}user:${userId}`;
    const cached = await safeCacheGet<{
      exists: boolean;
      user?: AuthServiceUser;
    }>(cacheKey);
    if (cached) {
      return cached.exists && cached.user ? cached.user : null;
    }

    try {
      const user = await requests.auth.getUser(userId);
      await safeCacheSet(
        cacheKey,
        { exists: true, user },
        USER_CACHE_TTL_SECONDS
      );
      return user;
    } catch (error) {
      if (getOriginalStatus(error) === 404) {
        await safeCacheSet(
          cacheKey,
          { exists: false },
          USER_NOT_FOUND_CACHE_TTL_SECONDS
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * Batch get users from core. Cached users are served from Redis; the rest
   * are fetched together, one request per `MAX_USER_IDS_PER_REQUEST` ids.
   * Returns a Map of userId -> user data (null if the user doesn't exist, or
   * the id is not a UUID).
   */
  async getUsers(
    userIds: string[]
  ): Promise<Map<string, AuthServiceUser | null>> {
    const uniqueUserIds = [...new Set(userIds)];
    const result = new Map<string, AuthServiceUser | null>();

    if (this.testMode) {
      for (const userId of uniqueUserIds) {
        result.set(userId, await this.getUser(userId));
      }
      return result;
    }

    const misses: string[] = [];
    await Promise.all(
      uniqueUserIds.map(async (userId) => {
        const cached = await safeCacheGet<{
          exists: boolean;
          user?: AuthServiceUser;
        }>(`${AUTH_CACHE_PREFIX}user:${userId}`);
        if (cached) {
          result.set(userId, cached.exists && cached.user ? cached.user : null);
        } else if (UUID_RE.test(userId)) {
          misses.push(userId);
        } else {
          result.set(userId, null);
        }
      })
    );

    for (let i = 0; i < misses.length; i += MAX_USER_IDS_PER_REQUEST) {
      const chunk = misses.slice(i, i + MAX_USER_IDS_PER_REQUEST);
      const found = new Map(
        (await requests.auth.getUsersByIds(chunk)).map((u) => [u.id, u])
      );
      await Promise.all(
        chunk.map(async (userId) => {
          const user = found.get(userId) ?? null;
          result.set(userId, user);
          await safeCacheSet(
            `${AUTH_CACHE_PREFIX}user:${userId}`,
            user ? { exists: true, user } : { exists: false },
            user ? USER_CACHE_TTL_SECONDS : USER_NOT_FOUND_CACHE_TTL_SECONDS
          );
        })
      );
    }

    return result;
  }

  /**
   * Validate that a user exists in core.
   */
  async validateUserExists(userId: string): Promise<boolean> {
    const user = await this.getUser(userId);
    return user !== null;
  }

  /**
   * Get an organization from core by its id (UUIDv7) — the same
   * value carried in the JWT `org_id` claim. Results are cached in Redis.
   * Returns null if the organization is not found.
   *
   * In test mode (`createCoreClient({ testMode: true })`), returns mock data for any input id.
   */
  async getOrganization(id: string): Promise<AuthServiceOrganization | null> {
    if (this.testMode) {
      const suffix = id.startsWith("test-org-")
        ? id.slice("test-org-".length)
        : id;
      // Derive `code` from the LAST block of the UUID — that block is pure
      // random for both UUIDv4 and UUIDv7. The leading bytes of UUIDv7 are
      // timestamp-based, so parallel tests in the same millisecond would
      // produce identical codes if we sliced from the front, causing
      // org-scoped formatted ids (e.g. `ACME-HOLD-00001`) to collide on
      // their unique constraints.
      const lastBlock = suffix.split("-").pop() || suffix;
      return {
        id,
        name: `Test Org ${suffix}`,
        slug: id.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        code: lastBlock
          .slice(0, 6)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "X"),
        isDefault: false,
        isActive: true,
        archivedAt: null,
        memberCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const cacheKey = `${AUTH_CACHE_PREFIX}org:${id}`;
    const cached = await safeCacheGet<{
      exists: boolean;
      org?: AuthServiceOrganization;
    }>(cacheKey);
    if (cached) {
      return cached.exists && cached.org ? cached.org : null;
    }

    try {
      const org = await requests.auth.getOrganizationById(id);
      await safeCacheSet(
        cacheKey,
        { exists: true, org },
        USER_CACHE_TTL_SECONDS
      );
      return org;
    } catch (error) {
      if (getOriginalStatus(error) === 404) {
        await safeCacheSet(
          cacheKey,
          { exists: false },
          USER_NOT_FOUND_CACHE_TTL_SECONDS
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * This service as core knows it: the provisioning document's version and
   * hash core last applied, when, and the service's access. Not cached — call
   * it at start to check the deploy's document has been applied.
   *
   * In test mode (`createCoreClient({ testMode: true })`), returns a stub.
   */
  async getService(): Promise<AuthServiceOwnService> {
    if (this.testMode) {
      return {
        id: "00000000-0000-7000-8000-000000000000",
        slug: "test-service",
        name: "Test service",
        namespace: "test",
        isActive: true,
        provisioned: true,
        declarationVersion: null,
        declarationHash: null,
        declaredAt: null,
        access: [],
      };
    }
    return await requests.auth.getOwnService();
  }

  /**
   * Express middleware that validates Bearer tokens and populates req.auth.
   * Arrow function property so it can be safely destructured.
   */
  requireAuth = async (
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;

      // Skip auth for public routes when no token is present
      if (this.publicRoutes.length > 0 && !authHeader) {
        const fullPath = req.originalUrl.split("?")[0];
        const isPublic = this.publicRoutes.some((route) => {
          const methods = route.methods ?? ["GET", "HEAD"];
          return methods.includes(req.method) && route.pattern.test(fullPath);
        });
        if (isPublic) return next();
      }

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new UnauthorizedError(
          "Authorization header with Bearer token required"
        );
      }

      const token = authHeader.slice(7);
      if (!token) throw new UnauthorizedError("Token required");

      const res = await this.introspectToken(token);
      if (!res.active) {
        throw new UnauthorizedError("Invalid or expired token");
      }

      req.auth = {
        userId: res.user_id,
        email: res.email || null,
        name: res.name || null,
        userType: tokenUserType(res),
        permissions: res.permissions || [],
        currentSessionId: res.sid || null,
        oauthClientId: res.client_id || null,
        organizationId: res.org_id || null,
        organizationName: res.org_name || null,
      };

      setAuthSpanAttrs(req.auth);

      next();
    } catch (error) {
      next(error);
    }
  };

  /**
   * Returns Express middleware that checks for a specific permission.
   * Must be used after requireAuth middleware.
   */
  requirePermission =
    (permission: string) =>
    (req: Request, _res: Response, next: NextFunction) => {
      const user = this.validateUser(req);

      setRequiredPermission(permission);

      const hasRequiredPermission = hasPermission(user.permissions, permission);
      if (!hasRequiredPermission) {
        throw new ForbiddenError(
          `The following permission is required: ${permission}`
        );
      }

      next();
    };

  /**
   * Validates that req.auth exists and returns the AuthContext.
   * Throws ForbiddenError if authentication is missing.
   */
  validateUser = (req: Request): AuthContext => {
    if (!req.auth) throw new ForbiddenError("Authentication required");
    return req.auth;
  };

  /**
   * Validates that req.organization exists and returns the OrganizationContext.
   * Optionally validates that the client ID matches a specific value.
   * Throws ForbiddenError if client context is missing or mismatched.
   */
  validateOrganization = (
    req: Request,
    organizationId?: string
  ): OrganizationContext => {
    if (!req.organization) {
      throw new ForbiddenError("Client context required");
    }
    if (
      organizationId !== undefined &&
      organizationId !== req.organization.id
    ) {
      throw new ForbiddenError("Resource does not belong to this client");
    }
    return req.organization;
  };
}
