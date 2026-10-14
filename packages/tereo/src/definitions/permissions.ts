import type { PermissionDefinition } from "./types.js";

// Core's permissions. Names are enforced by `requirePermission` calls and
// stored in issued tokens. Event types and permissions themselves are
// declared in code, so only their `read` permissions exist.
//
// Org-assignable (`orgAssignable: true`) are the permissions whose every use
// is confined to the token's organization: files' buckets, objects, grants
// and shares; webhooks' endpoints, deliveries and emitting; reading and
// writing audit entries. A role assigned within an organization grants only
// these. Everything that reaches past one organization stays global-only:
// `admin`; users, roles, permissions, clients, settings and services, which
// are platform-wide; `organizations.*`, whose holders bypass organization
// membership (`requireOrgRole`); and the per-area administrators
// `file-service.admin`, `webhooks.admin` and `audit-logs.admin`, which act on
// any organization. `audit-logs.delete` has no route yet, so it stays out
// until one shows its scope.

type Action = "read" | "write" | "archive" | "delete" | "admin";

function domainPermissions(
  domain: string,
  displayName: string,
  description: string,
  actions: Action[] = ["read", "write", "delete", "admin"],
  orgAssignable = false
): PermissionDefinition[] {
  return actions.map((action) => ({
    orgAssignable,
    name: `${domain}.${action}`,
    displayName: `${displayName} - ${action.charAt(0).toUpperCase() + action.slice(1)}`,
    description: `${
      action === "admin"
        ? "Full administrative access to"
        : action === "delete"
          ? "Permanently delete"
          : action === "archive"
            ? "Archive and restore"
            : action === "write"
              ? "Create and modify"
              : "View"
    } ${description.toLowerCase()}`,
  }));
}

function adminPermission(
  name: string,
  displayName: string,
  description: string
): PermissionDefinition {
  return { name, displayName, description };
}

const ALL_ACTIONS: Action[] = ["read", "write", "delete", "admin"];

/** Everything. Held by the `admin` role. */
const ADMIN_PERMISSION: PermissionDefinition = {
  name: "admin",
  displayName: "Administrator",
  description: "Full administrative access to all system features",
};

const SERVICE_PERMISSIONS: PermissionDefinition[] = [
  {
    name: "services.read",
    displayName: "Read Services",
    description: "View services, their declarations and requested access",
  },
  {
    name: "services.write",
    displayName: "Write Services",
    description:
      "Add, rename, deactivate services and regenerate their secrets",
  },
  {
    name: "services.approve",
    displayName: "Approve Service Access",
    description: "Approve or revoke the access services request",
  },
];

// Explicit set (not domainPermissions()) to preserve the exact names + action subsets the service enforces — settings is read/write only, no per-domain .admin wildcards.
const AUTH_SERVICE_PERMISSIONS: PermissionDefinition[] = [
  adminPermission("users.read", "Read Users", "View user accounts and details"),
  adminPermission(
    "users.write",
    "Write Users",
    "Create and modify user accounts"
  ),
  adminPermission(
    "users.delete",
    "Delete Users",
    "Delete user accounts and revoke sessions"
  ),
  adminPermission(
    "roles.read",
    "Read Roles",
    "View roles and their permissions"
  ),
  adminPermission("roles.write", "Write Roles", "Create and modify roles"),
  adminPermission(
    "roles.archive",
    "Archive Roles",
    "Archive and restore roles"
  ),
  adminPermission(
    "roles.delete",
    "Delete Roles",
    "Permanently delete roles and remove user assignments"
  ),
  adminPermission("permissions.read", "Read Permissions", "View permissions"),
  adminPermission("clients.read", "Read Clients", "View OAuth clients"),
  adminPermission(
    "clients.write",
    "Write Clients",
    "Create and modify OAuth clients"
  ),
  adminPermission("clients.delete", "Delete Clients", "Delete OAuth clients"),
  adminPermission(
    "clients.admin",
    "Administer Clients",
    "Manage OAuth clients owned by other users"
  ),
  adminPermission("settings.read", "Read Settings", "View system settings"),
  adminPermission("settings.write", "Write Settings", "Modify system settings"),
  adminPermission(
    "organizations.read",
    "Read Organizations",
    "View organizations"
  ),
  adminPermission(
    "organizations.write",
    "Write Organizations",
    "Create and modify organizations"
  ),
  adminPermission(
    "organizations.archive",
    "Archive Organizations",
    "Archive and restore organizations"
  ),
  adminPermission(
    "identity-providers.read",
    "Read Identity Providers",
    "View identity providers and their domains"
  ),
  adminPermission(
    "identity-providers.write",
    "Write Identity Providers",
    "Create and modify identity providers, their domains and default roles"
  ),
];

const FILE_SERVICE_PERMISSIONS: PermissionDefinition[] = [
  adminPermission(
    "file-service.admin",
    "File Storage Administrator",
    "Full file storage access"
  ),
  ...domainPermissions(
    "file-service.buckets",
    "File Storage Buckets",
    "File storage buckets",
    ALL_ACTIONS,
    true
  ),
  ...domainPermissions(
    "file-service.objects",
    "File Storage Objects",
    "File storage objects",
    ALL_ACTIONS,
    true
  ),
  ...domainPermissions(
    "file-service.permissions",
    "File Storage Permissions",
    "File storage permissions",
    ALL_ACTIONS,
    true
  ),
  ...domainPermissions(
    "file-service.shares",
    "File Storage Shares",
    "Revocable, shareable file download links",
    ALL_ACTIONS,
    true
  ),
];

const AUDIT_LOG_PERMISSIONS: PermissionDefinition[] = [
  adminPermission(
    "audit-logs.admin",
    "Audit Logs Administrator",
    "Full audit log access"
  ),
  ...domainPermissions(
    "audit-logs",
    "Audit Logs",
    "audit logs",
    ["read", "write"],
    true
  ),
  ...domainPermissions("audit-logs", "Audit Logs", "audit logs", ["delete"]),
];

const WEBHOOK_PERMISSIONS: PermissionDefinition[] = [
  adminPermission(
    "webhooks.admin",
    "Webhooks Administrator",
    "Full webhook access"
  ),

  ...domainPermissions(
    "webhooks",
    "Webhooks",
    "webhooks",
    ["read", "write", "archive", "delete"],
    true
  ),
  {
    name: "webhooks.emit",
    displayName: "Webhooks - Emit",
    description: "Emit webhook events",
    orgAssignable: true,
  },
  {
    name: "webhooks.event-types.read",
    displayName: "Webhook Event Types - Read",
    description: "View webhook event types",
    orgAssignable: true,
  },
];

const NOTIFICATION_PERMISSIONS: PermissionDefinition[] = [
  {
    name: "notifications.send",
    displayName: "Notifications - Send",
    description: "Send notifications",
  },
  {
    name: "notifications.read",
    displayName: "Notifications - Read",
    description: "View notification deliveries",
  },
  adminPermission(
    "notifications.admin",
    "Notifications Administrator",
    "Full notification access, including connections"
  ),
];

/** Every permission core declares. */
export const PERMISSION_CATALOG: PermissionDefinition[] = [
  ADMIN_PERMISSION,
  ...AUTH_SERVICE_PERMISSIONS,
  ...SERVICE_PERMISSIONS,
  ...FILE_SERVICE_PERMISSIONS,
  ...WEBHOOK_PERMISSIONS,
  ...AUDIT_LOG_PERMISSIONS,
  ...NOTIFICATION_PERMISSIONS,
];

/**
 * Permission names enforced by `requirePermission` — the same names as
 * `PERMISSION_CATALOG` above, as constants for call sites.
 *
 * File operations also require a per-bucket grant on `BucketPermission`
 * (`canRead`/`canWrite`/`canDelete`) — see docs/files.md "Dual Permission Model".
 */
export const PERMISSIONS = {
  // Buckets — bucket lifecycle & metadata
  buckets: {
    read: "file-service.buckets.read",
    write: "file-service.buckets.write",
    delete: "file-service.buckets.delete",
    admin: "file-service.buckets.admin",
  },

  // Objects — upload/download/list/delete
  objects: {
    read: "file-service.objects.read",
    write: "file-service.objects.write",
    delete: "file-service.objects.delete",
    admin: "file-service.objects.admin",
  },

  // Bucket permission grants (BucketPermission rows)
  permissions: {
    read: "file-service.permissions.read",
    write: "file-service.permissions.write",
    delete: "file-service.permissions.delete",
    admin: "file-service.permissions.admin",
  },

  // Revocable shareable download links
  shares: {
    read: "file-service.shares.read",
    write: "file-service.shares.write",
    delete: "file-service.shares.delete",
    admin: "file-service.shares.admin",
  },

  // Service-level admin (covers all of the above)
  admin: "file-service.admin",

  WEBHOOKS: {
    ADMIN: "webhooks.admin",
    READ: "webhooks.read",
    WRITE: "webhooks.write",
    ARCHIVE: "webhooks.archive",
    DELETE: "webhooks.delete",
    EMIT: "webhooks.emit",
    EVENT_TYPES: {
      READ: "webhooks.event-types.read",
    },
  },

  NOTIFICATIONS: {
    SEND: "notifications.send",
    READ: "notifications.read",
    ADMIN: "notifications.admin",
  },

  AUDIT_LOGS: {
    ADMIN: "audit-logs.admin",
    READ: "audit-logs.read",
    WRITE: "audit-logs.write",
    DELETE: "audit-logs.delete",
  },
} as const;
