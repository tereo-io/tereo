// What a service declares at boot — the body of core's
// `POST /v1/registry/declaration`. See tereo's docs/registry.md.

export interface PermissionDeclaration {
  /** `<namespace>` or `<namespace>.…`. */
  name: string;
  displayName: string;
  description?: string;
  /**
   * May be granted by a role assigned within an organization (default
   * false). Only for a permission whose every use stays inside the caller's
   * organization; an org-scoped role grants nothing else.
   */
  orgAssignable?: boolean;
}

export interface SystemRoleDeclaration {
  /** `<namespace>_<name>`, e.g. `billing_editor` for the namespace `billing`. */
  name: string;
  displayName: string;
  description?: string;
  /** Only permissions this same declaration lists. */
  permissions: string[];
}

export interface BucketDeclaration {
  /** `<namespace>-…`. Policy and quota apply when the bucket is created. */
  bucketName: string;
  description?: string;
  policy?: "public" | "private";
  storageQuotaBytes?: number;
}

export interface EventTypeDeclaration {
  /** `<namespace>.…`. */
  eventType: string;
  description?: string;
  /**
   * A permission (this service's or core's) that a webhook endpoint's creator
   * must hold to subscribe to the event and be sent it. Without one, holding
   * `webhooks.read` is enough.
   */
  readPermission?: string;
}

export interface RequestedAccess {
  /** System roles to hold: a bare name for core's, `<slug>/<name>` for another service's. */
  roles?: string[];
  /** Slugs of services that may introspect this service's tokens. */
  audiences?: string[];
}

export interface Declaration {
  /**
   * Semver of the release declaring it (`MAJOR.MINOR.PATCH[-prerelease]`).
   * Core ignores a declaration older than the one it applied last, so a
   * replica of an earlier release cannot undo a rollout. `register()`
   * defaults it to `npm_package_version`, else the version in
   * `package.json` in the working directory.
   */
  version?: string;
  permissions?: PermissionDeclaration[];
  systemRoles?: SystemRoleDeclaration[];
  buckets?: BucketDeclaration[];
  eventTypes?: EventTypeDeclaration[];
  requestedAccess?: RequestedAccess;
}

export interface ServiceAccess {
  id: string;
  kind: "role" | "audience";
  target: string;
  /**
   * Only `approved` access applies; an admin decides under
   * /v1/admin/services. Another service's role grants what its approval
   * recorded: when that service adds permissions to it, the access is
   * `pending` again, and the additions apply once approved.
   */
  status: "pending" | "approved" | "revoked";
}

export interface RegistrationResult {
  service: string;
  /**
   * False when core ignored the declaration: its version is older than the
   * one core applied last.
   */
  applied: boolean;
  /** False when core already had this exact declaration. */
  changed: boolean;
  access: ServiceAccess[];
}
