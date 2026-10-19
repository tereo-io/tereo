export type {
  IntrospectionResponse,
  ActiveIntrospectionResponse,
  InactiveIntrospectionResponse,
  AuthServiceOrganization,
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
   * Longest time an active introspection is cached (default: 60). A signed-out
   * or revoked token stays accepted for up to this long; 0 asks core every time.
   */
  introspectionCacheTtlSeconds?: number;
}
