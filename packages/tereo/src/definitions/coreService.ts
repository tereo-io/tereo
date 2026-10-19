// Core's own row in `core.services`, inserted by the registration migration.
// Core declares its permissions, system roles, buckets and event types at
// start, through the same path app services use, but in-process and with no
// OAuth client.
export const CORE_SERVICE = {
  id: "00000000-0000-7000-8000-000000000002",
  slug: "core",
  name: "tereo",
  namespace: "core",
} as const;

export const CORE_SERVICE_ID = CORE_SERVICE.id;

/** `source` recorded on every audit entry and webhook event core produces. */
export const CORE_SOURCE = "tereo";

/**
 * Slugs no service or integration may take: core's own, and `CORE_SOURCE` —
 * a service writes and reads audit entries under its slug as their source, so
 * one slugged `tereo` would pass for core.
 */
export const CORE_RESERVED_SLUGS: readonly string[] = [
  CORE_SERVICE.slug,
  CORE_SOURCE,
];

/**
 * Prefixes core's names already use besides its `core` namespace. Core's own
 * declaration is checked against them, and no service may take a namespace
 * that equals or overlaps one.
 */
export const CORE_RESERVED_NAMESPACES = [
  "core",
  "admin",
  "users",
  "roles",
  "permissions",
  "clients",
  "settings",
  "organizations",
  "services",
  "integrations",
  "auth",
  "auth-service",
  "file-service",
  "audit-logs",
  "webhooks",
  "webhook",
  "identity-providers",
  "notifications",
  "notification",
] as const;
