// The provisioning document a service's build writes and the deploy pipeline
// hands to core. Hand-written to mirror the input shape of core's schema
// (`packages/tereo/src/utils/provisioning/schema.ts`): a field is optional
// where the schema has a default or marks it optional. Unknown keys are
// rejected by core, and by these types.

export interface PermissionProvisioning {
  /** `<namespace>` or `<namespace>.…`: lowercase letters, digits, `. _ -`. */
  name: string;
  displayName: string;
  /** At most 500 characters. Default "". */
  description?: string;
  /** May be granted by an organization-scoped role. Default false. */
  orgAssignable?: boolean;
}

export interface SystemRoleProvisioning {
  /** `<namespace>_<name>`, e.g. `billing_editor`. */
  name: string;
  displayName: string;
  description?: string;
  /** Permissions this same document lists. Default []. */
  permissions?: string[];
}

export interface BucketProvisioning {
  /** `<namespace>-…`, 3 to 63 characters. */
  bucketName: string;
  description?: string;
  /** Default `"private"`. */
  policy?: "public" | "private";
  /** At most 1 TiB (2^40 bytes), as on the bucket API; a digit string works too. */
  storageQuotaBytes?: number | string;
}

export interface EventTypeProvisioning {
  /** `<namespace>.…`. */
  eventType: string;
  description?: string;
  /** Permission a webhook endpoint's creator must hold to subscribe. */
  readPermission?: string;
}

/** A webhook endpoint the service owns; core signs deliveries with the secret read from `secretFrom`. */
export interface WebhookSubscription {
  /** Stable identity of the subscription within the service. */
  key: string;
  url: string;
  /** At least one event type. */
  events: string[];
  /** Name of the environment variable, in core's environment, that holds the signing secret. */
  secretFrom: string;
  /** `"all"` (default) or at least one organization id. */
  organizations?: "all" | string[];
  description?: string;
}

export interface ServiceProvisioning {
  slug: string;
  name: string;
  /** Defaults to the slug without a trailing `-service`. */
  namespace?: string;
  clientId?: string;
  /**
   * The service's own private hostname or IP address (no scheme, port, path
   * or CIDR). Its webhooks may target it even when it resolves to a private
   * address; loopback, link-local, unspecified and multicast are never allowed.
   */
  internalHost?: string;
  /** Name of the environment variable, in core's environment, that holds the client secret. */
  secretFrom: string;
  /** Access the service asks for; approved by the document itself. */
  access?: {
    /** A bare name for core's roles, `<slug>/<name>` for another service's. */
    roles?: string[];
    /** Slugs of services that may introspect this service's tokens. */
    audiences?: string[];
  };
  permissions?: PermissionProvisioning[];
  systemRoles?: SystemRoleProvisioning[];
  buckets?: BucketProvisioning[];
  eventTypes?: EventTypeProvisioning[];
  webhooks?: WebhookSubscription[];
}

/** An OAuth client for signing in to an app. */
export interface LoginClientProvisioning {
  clientId: string;
  name: string;
  /** Default `"public"`. */
  clientType?: "public" | "confidential";
  /** Name of the environment variable that holds the secret; for a confidential client. */
  secretFrom?: string;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  /** Default both. */
  grantTypes?: ("authorization_code" | "refresh_token")[];
  audience?: string[];
  /** Default true. */
  consentRequired?: boolean;
  /**
   * Core scopes (from `scopes`) the user is not asked to approve when
   * `consentRequired` is false. Never `core:admin` or `core:admin.read`.
   */
  trustedCoreScopes?: string[];
  description?: string;
}

/** An organization-assignable or system-wide role made of permissions, outside any one service. */
export interface CustomRole {
  /** Lowercase letters, digits, `_ -`, starting with a letter. */
  name: string;
  displayName: string;
  description?: string;
  /** Default false. */
  orgAssignable?: boolean;
  /** Holders must have 2FA enrolled. Default false. */
  requires2fa?: boolean;
  permissions: string[];
}

/**
 * A machine client for an external party (a 3PL, a customer's system). Its
 * client id is its slug. It declares nothing.
 */
export interface IntegrationProvisioning {
  slug: string;
  name: string;
  /**
   * Org-bound when set: its tokens carry this `org_id`, and it holds only
   * org-assignable custom roles there. Fixed once created.
   */
  organizationId?: string;
  /** Name of the environment variable, in core's environment, that holds the client secret. */
  secretFrom: string;
  /**
   * Role names. Org-bound: org-assignable custom roles of the set. Otherwise
   * also core's roles and `<slug>/<name>` services' system roles. Default [].
   */
  roles?: string[];
  /** Slugs of services in the set that may introspect its tokens. Default []. */
  audiences?: string[];
}

/**
 * One file; it needs at least one of `service`, `clients`, `roles`,
 * `integrations`, not empty.
 */
export interface ProvisioningDocument {
  $schema?: string;
  /** Semver of the release: `MAJOR.MINOR.PATCH[-prerelease]`. */
  version: string;
  service?: ServiceProvisioning;
  clients?: LoginClientProvisioning[];
  roles?: CustomRole[];
  integrations?: IntegrationProvisioning[];
}
