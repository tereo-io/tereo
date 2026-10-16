import type { EventTypeDefinition } from "./types.js";

// Webhook event types core emits. Add a new event here AND at its emit site —
// `emitTx` rejects event types not listed.

const authEvents: EventTypeDefinition[] = [
  {
    eventType: "auth.organization.created",
    description: "Organization created",
  },
  {
    eventType: "auth.organization.updated",
    description: "Organization updated",
  },
  {
    eventType: "auth.organization.archived",
    description: "Organization archived",
  },
  {
    eventType: "auth.organization.restored",
    description: "Organization restored from the archive (still deactivated)",
  },
  {
    eventType: "auth.organization.member-added",
    description: "User added to an organization",
  },
  {
    eventType: "auth.organization.member-updated",
    description: "Organization member's role (owner/admin/member) changed",
  },
  {
    eventType: "auth.organization.member-removed",
    description: "User removed from an organization",
  },
  {
    eventType: "auth.organization.member-roles-changed",
    description: "Organization member's org-scoped role assignments changed",
  },
  { eventType: "auth.user.created", description: "User created" },
  { eventType: "auth.user.updated", description: "User profile updated" },
  {
    eventType: "auth.user.roles-changed",
    description: "User role assignments changed",
  },
  {
    eventType: "auth.user.password-changed",
    description: "User changed their own password",
  },
  {
    eventType: "auth.user.sessions-revoked",
    description: "Sessions of a user revoked, by the user or an admin",
  },
  {
    eventType: "auth.user.recovery-codes-regenerated",
    description: "User regenerated their own TOTP recovery codes",
  },
  {
    eventType: "auth.user.totp-enabled",
    description: "User enabled TOTP (MFA) on their account",
  },
  {
    eventType: "auth.user.totp-disabled",
    description:
      "TOTP (MFA) disabled on a user's account, by the user or an admin",
  },
  {
    eventType: "auth.user.totp-reset",
    description:
      "An admin reset a user's TOTP (MFA): disabled, recovery codes deleted",
  },
  { eventType: "auth.role.created", description: "Role created" },
  { eventType: "auth.role.updated", description: "Role updated" },
  { eventType: "auth.role.archived", description: "Role archived" },
  {
    eventType: "auth.role.restored",
    description: "Role restored from the archive (still deactivated)",
  },
  {
    eventType: "auth.role.deleted",
    description: "Role permanently deleted (assignments removed)",
  },
  {
    eventType: "auth.role.permissions-changed",
    description: "Role permission set changed",
  },
  {
    eventType: "auth.role.user-removed",
    description: "User removed from role",
  },
  { eventType: "auth.client.created", description: "OAuth client created" },
  {
    eventType: "auth.client.updated",
    description: "OAuth client configuration updated",
  },
  { eventType: "auth.client.deleted", description: "OAuth client deleted" },
  {
    eventType: "auth.client.secret-regenerated",
    description: "OAuth client secret rotated",
  },
  {
    eventType: "auth.settings.updated",
    description: "System settings (TOTP policy) updated",
  },
  {
    eventType: "auth.identity-provider.created",
    description: "Identity provider created",
  },
  {
    eventType: "auth.identity-provider.updated",
    description: "Identity provider configuration updated",
  },
  {
    eventType: "auth.identity-provider.deactivated",
    description: "Identity provider deactivated",
  },
  {
    eventType: "auth.identity-provider.activated",
    description: "Identity provider reactivated",
  },
  {
    eventType: "auth.user.identity-linked",
    description: "Upstream identity linked to a user",
  },
  {
    eventType: "auth.user.identity-unlinked",
    description: "Upstream identity unlinked from a user",
  },
];

const fileEvents: EventTypeDefinition[] = [
  { eventType: "file-service.bucket.created", description: "Bucket created" },
  { eventType: "file-service.bucket.updated", description: "Bucket updated" },
  {
    eventType: "file-service.bucket.deleted",
    description: "Bucket soft-deleted",
  },
  {
    eventType: "file-service.object.created",
    description: "Object uploaded for the first time",
  },
  {
    eventType: "file-service.object.updated",
    description: "Object overwritten",
  },
  {
    eventType: "file-service.object.deleted",
    description: "Object soft-deleted (or delete marker in versioned buckets)",
  },
  {
    eventType: "file-service.objects.bulk-deleted",
    description:
      "A bulk delete (by prefix or id list) soft-deleted N objects in one request",
  },
  {
    eventType: "file-service.object.version.created",
    description: "New object version created",
  },
  {
    eventType: "file-service.object.version.restored",
    description: "Prior version restored as current",
  },
  {
    eventType: "file-service.object.version.deleted",
    description: "A specific non-current version hard-deleted",
  },
  {
    eventType: "file-service.objects.versions.purged",
    description:
      "An on-demand purge soft-deleted N non-current versions across a bucket",
  },
  {
    eventType: "file-service.permission.granted",
    description: "Bucket-level permission granted to a user",
  },
  {
    eventType: "file-service.permission.revoked",
    description: "Bucket-level permission revoked from a user",
  },
  {
    eventType: "file-service.multipart.initiated",
    description: "Multipart upload initiated",
  },
  {
    eventType: "file-service.multipart.completed",
    description: "Multipart upload completed",
  },
  {
    eventType: "file-service.multipart.aborted",
    description: "Multipart upload aborted or expired",
  },
  {
    eventType: "file-service.lifecycle.policy.updated",
    description: "Bucket lifecycle policy created or replaced",
  },
  {
    eventType: "file-service.lifecycle.policy.deleted",
    description: "Bucket lifecycle policy removed",
  },
  {
    eventType: "file-service.lifecycle.policy.applied",
    description:
      "Lifecycle sweep applied (soft-deletes, version purge, or hard-delete)",
  },
  {
    eventType: "file-service.share.created",
    description: "Share link created for an object or archive",
  },
  {
    eventType: "file-service.share.updated",
    description: "Share link updated (password, TTL, cap, filename, or note)",
  },
  {
    eventType: "file-service.share.revoked",
    description: "Share link revoked (soft); subsequent downloads return 404",
  },
  {
    eventType: "file-service.share.accessed",
    description:
      "Share link downloaded (gated by FILE_SERVICE_EMIT_SHARE_ACCESS_EVENTS; noisy)",
  },
];

/** Sent only by `POST /v1/webhooks/webhooks/:id/test`. */
export const TEST_EVENT_TYPE = "webhook.test";

/**
 * Registered, but nothing may emit them and no endpoint may subscribe to
 * them: emit and endpoint create/update answer `400 reserved_event_type`.
 */
export const RESERVED_EVENT_TYPES: ReadonlySet<string> = new Set([
  TEST_EVENT_TYPE,
]);

// Registered because a delivery's event type is a foreign key into the
// registry, so test deliveries need the row.
const webhookEvents: EventTypeDefinition[] = [
  {
    eventType: TEST_EVENT_TYPE,
    description: "Test delivery sent on request to a single endpoint",
  },
];

const serviceEvents: EventTypeDefinition[] = [
  { eventType: "core.service.created", description: "Service added" },
  {
    eventType: "core.service.updated",
    description: "Service renamed, deactivated or reactivated",
  },
  {
    eventType: "core.service.secret-regenerated",
    description: "Service client secret regenerated",
  },
  {
    eventType: "core.service.previous-secret-revoked",
    description:
      "Service's previous client secret revoked before its overlap ended",
  },
  {
    eventType: "core.service.declared",
    description: "Service registered a changed declaration",
  },
  {
    eventType: "core.service.access-approved",
    description: "Requested service access approved",
  },
  {
    eventType: "core.service.access-revoked",
    description: "Service access revoked",
  },
];

const keyEvents: EventTypeDefinition[] = [
  {
    eventType: "core.signing-key.rotated",
    description:
      "JWT signing key rotated: a new kid is published and signs from activatesAt, the previous one is retired then",
  },
];

const notificationEvents: EventTypeDefinition[] = [
  {
    eventType: "notification.sent",
    description: "Notification delivered to its provider",
  },
  {
    eventType: "notification.failed",
    description: "Notification delivery failed for good, after its retries",
  },
  {
    eventType: "notification.connection.created",
    description: "Notification connection created",
  },
  {
    eventType: "notification.connection.updated",
    description: "Notification connection updated",
  },
  {
    eventType: "notification.connection.deleted",
    description: "Notification connection deleted",
  },
];

// The permission that reads what an event carries, by event-type prefix; the
// first match wins. Platform-wide events are emitted under the default
// organization, so without these any member of it allowed to manage webhooks
// would receive every user, client and service change. File events are also
// checked against the bucket they name (`utils/webhookAccess.ts`).
const READ_PERMISSIONS: [prefix: string, permission: string][] = [
  ["auth.organization.", "organizations.read"],
  ["auth.user.", "users.read"],
  ["auth.role.", "roles.read"],
  ["auth.client.", "clients.read"],
  ["auth.settings.", "settings.read"],
  ["auth.identity-provider.", "identity-providers.read"],
  ["file-service.bucket.", "file-service.buckets.read"],
  ["file-service.permission.", "file-service.permissions.read"],
  ["file-service.share.", "file-service.shares.read"],
  ["file-service.", "file-service.objects.read"],
  ["core.service.", "services.read"],
  ["core.signing-key.", "settings.read"],
  ["notification.connection.", "notifications.admin"],
  ["notification.", "notifications.read"],
];

const withReadPermission = (e: EventTypeDefinition): EventTypeDefinition => {
  if (e.eventType === TEST_EVENT_TYPE) return e;
  const match = READ_PERMISSIONS.find(([prefix]) =>
    e.eventType.startsWith(prefix)
  );
  if (!match) {
    throw new Error(`No read permission for event type "${e.eventType}"`);
  }
  return { ...e, readPermission: match[1] };
};

export const EVENT_TYPES: EventTypeDefinition[] = [
  ...authEvents,
  ...fileEvents,
  ...webhookEvents,
  ...serviceEvents,
  ...keyEvents,
  ...notificationEvents,
].map(withReadPermission);
