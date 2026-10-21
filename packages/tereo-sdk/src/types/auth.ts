export type {
  IntrospectionResponse,
  ActiveIntrospectionResponse,
  InactiveIntrospectionResponse,
  AuthServiceOrganization,
  AuthServiceOwnService,
  AuthServiceOwnServiceAccess,
  AuthServiceUser,
} from "../handler.js";

export type UserType = "human" | "service_account";

export interface AuthContext {
  userId: string;
  email: string | null;
  name: string | null;
  userType: UserType;
  permissions: string[];
  currentSessionId: string | null;
  /** The OAuth client the token was issued to (introspection's `client_id`). */
  clientId: string;
  /**
   * The token's granted scopes, from introspection's space-separated `scope`.
   * Check them with `requireScope` before honouring a third-party login
   * client's token for this service's own API.
   */
  scope: string[];
  /** The token's audience (`aud`), always as a list; empty when it has none. */
  audience: string[];
  /**
   * The token's `client_id`, the same value as `clientId`, or null when
   * introspection has none. Kept for compatibility: core's own
   * `AuthContext.oauthClientId` is a different thing (the user's own client
   * when the user is a service account), so use `clientId` instead.
   *
   * @deprecated Use `clientId`.
   */
  oauthClientId: string | null;
  organizationId: string | null;
  organizationName: string | null;
}

/**
 * Per-request tenant context. `id` is core's Organization.id (UUIDv7)
 * — interchangeable across all services; same value as the JWT `org_id` claim.
 */
export interface OrganizationContext {
  id: string;
  code: string;
  name: string;
}

export interface PublicRouteConfig {
  /** Regex pattern to match against the request path (without query string) */
  pattern: RegExp;
  /** HTTP methods to allow without auth (default: ['GET', 'HEAD']) */
  methods?: string[];
}

export interface AuthServiceClientConfig {
  /** Permissions granted to test tokens in test mode (default: []). */
  defaultTestPermissions?: string[];
  /** Routes that can be accessed without authentication (default: []). */
  publicRoutes?: PublicRouteConfig[];
  /**
   * Longest time an active introspection is cached (default: 60, at most
   * 300). A signed-out or revoked token stays accepted for up to this long;
   * 0 asks core every time.
   */
  introspectionCacheTtlSeconds?: number;
  /**
   * OAuth clients whose tokens `requireAuth` accepts, by `client_id`. A token
   * issued to any other client is refused with 401. Default: every client
   * core reports the token active for.
   */
  allowedClients?: string[];
}
