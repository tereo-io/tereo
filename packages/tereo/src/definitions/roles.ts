import type { RoleDefinition } from "./types.js";

// Core's system roles. `admin` holds the `admin` permission, which covers
// everything. The roles after `file_user` are the ones app services request.
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
    displayName: "Tenant Resolver",
    description:
      "Allows a backend service account to resolve organization (tenant) context",
    permissions: ["organizations.read"],
  },
  {
    name: "user_resolver",
    displayName: "User Resolver",
    description:
      "Allows a backend service account to resolve user display details (name, email)",
    permissions: ["users.read"],
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
    displayName: "Webhook Publisher",
    description: "Emit webhook events of the event types its service declares",
    permissions: ["webhooks.emit"],
  },
  {
    name: "audit_writer",
    displayName: "Audit Writer",
    description: "Write audit log entries",
    permissions: ["audit-logs.write"],
  },
  {
    name: "notification_sender",
    displayName: "Notification Sender",
    description: "Send notifications",
    permissions: ["notifications.send"],
  },
];
