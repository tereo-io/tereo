import type { RoleDefinition } from "./types.js";

// Core's system roles. `admin` holds the `admin` permission, which covers
// everything. App services may request the ones marked `requestable`.
export const ROLES: RoleDefinition[] = [
  {
    name: "admin",
    displayName: "Administrator",
    description: "Full system administrator access",
    permissions: ["admin"],
  },
  {
    name: "file_service_admin",
    displayName: "File Storage Administrator",
    description: "Full access to file storage",
    permissions: ["file-service.admin"],
  },
  {
    name: "audit_log_admin",
    displayName: "Audit Log Administrator",
    description: "Full access to the audit log",
    permissions: ["audit-logs.admin"],
  },
  {
    name: "webhook_admin",
    displayName: "Webhook Administrator",
    description: "Full access to webhooks",
    permissions: ["webhooks.admin"],
  },
  {
    name: "tenant_resolver",
    requestable: true,
    displayName: "Tenant Resolver",
    description:
      "Allows a backend service account to resolve organization (tenant) context",
    permissions: ["organizations.read"],
  },
  {
    name: "user_resolver",
    requestable: true,
    displayName: "User Resolver",
    description:
      "Allows a backend service account to resolve user display details (name, email)",
    permissions: ["users.read"],
  },
  {
    name: "group_resolver",
    requestable: true,
    displayName: "Group Resolver",
    description:
      "Read-only access to every group, global and in every organization: list and search them, read each one's roles, its members' names, emails and active flag, and its SCIM skipped members (names, emails), and receive auth.group.* webhook events",
    permissions: ["groups.read"],
  },
  {
    name: "platform_admin",
    displayName: "Platform Administrator",
    description:
      "Cross-service administrator with full access to all platform services",
    permissions: [
      "file-service.admin",
      "audit-logs.admin",
      "webhooks.admin",
      "organizations.read",
    ],
  },
  {
    name: "file_user",
    requestable: true,
    displayName: "File User",
    description:
      "Read the settings of, and read, write and delete objects in, buckets the holder has been granted",
    permissions: [
      "file-service.buckets.read",
      "file-service.objects.read",
      "file-service.objects.write",
      "file-service.objects.delete",
    ],
  },
  {
    name: "webhook_publisher",
    requestable: true,
    displayName: "Webhook Publisher",
    description: "Emit webhook events of the event types its service declares",
    permissions: ["webhooks.emit"],
  },
  {
    name: "audit_writer",
    requestable: true,
    displayName: "Audit Writer",
    description: "Write audit log entries",
    permissions: ["audit-logs.write"],
  },
  {
    name: "audit_reader",
    requestable: true,
    displayName: "Audit Reader",
    description: "Read the audit entries its own service wrote",
    permissions: ["audit-logs.read"],
  },
  {
    name: "notification_sender",
    requestable: true,
    displayName: "Notification Sender",
    description: "Send notifications",
    permissions: ["notifications.send"],
  },
  {
    name: "guest_inviter",
    requestable: true,
    displayName: "Guest Inviter",
    description: "Invite and manage guest users",
    permissions: ["users.guests.read", "users.guests.write"],
  },
];

const REQUESTABLE = new Set(
  ROLES.filter((role) => role.requestable).map((role) => role.name)
);

/** Whether an app service may request this core role by its bare name. */
export const isRequestableCoreRole = (name: string): boolean =>
  REQUESTABLE.has(name);
