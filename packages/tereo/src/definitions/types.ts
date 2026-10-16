// Shapes of a declaration: what a service owns, registered at every start.
// Core declares itself with these too (definitions/declaration.ts).

export interface PermissionDefinition {
  name: string;
  displayName: string;
  description: string;
  /**
   * May be granted by a role assigned within an organization. Only for a
   * permission whose every use stays inside the token's organization.
   */
  orgAssignable?: boolean;
}

/** A system role. Grants only permissions its own service declares. */
export interface RoleDefinition {
  name: string;
  displayName: string;
  description: string;
  /** Permission names this role grants. */
  permissions: string[];
  /** Core's roles only: an app service may request it in its declaration. */
  requestable?: boolean;
}

export interface BucketDefinition {
  bucketName: string;
  description?: string;
  policy: "public" | "private";
  storageQuotaBytes?: number;
}

export interface EventTypeDefinition {
  eventType: string;
  description: string;
  /**
   * What an endpoint's creator must hold, besides `webhooks.read`, to
   * subscribe to the event and be sent it: the service's own permission or
   * one of core's. Without one, `webhooks.read` is enough.
   */
  readPermission?: string;
}

export interface Declaration {
  /** Semver of the release declaring it; an older one than applied is ignored. */
  version: string;
  permissions: PermissionDefinition[];
  systemRoles: RoleDefinition[];
  buckets: BucketDefinition[];
  eventTypes: EventTypeDefinition[];
}
