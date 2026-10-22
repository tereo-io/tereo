import type { TestTagDefinition } from "vitest/config";

export const TIER_TAGS = ["unit", "int"] as const;
export const AREA_TAGS = [
  "auth",
  "files",
  "webhooks",
  "notifications",
  "audit",
  "provisioning",
  "platform",
] as const;
export const DETAIL_TAGS = [
  "race",
  "job",
  "security",
  "slow",
  "redis-outage",
] as const;
export const ASPECTS = [
  "validation",
  "permissions",
  "races",
  "audit",
  "limits",
  "errors",
] as const;
export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type TierTag = (typeof TIER_TAGS)[number];
export type AreaTag = (typeof AREA_TAGS)[number];
export type DetailTag = (typeof DETAIL_TAGS)[number];

declare module "vitest" {
  interface TestTags {
    tag: TierTag | AreaTag | DetailTag;
  }
}

export const TAGS: TestTagDefinition[] = [
  { name: "unit", description: "Runs with no database, Redis or server" },
  {
    name: "int",
    description: "Runs against the real server, Postgres and Redis",
  },
  { name: "auth", description: "Sign-in, tokens, accounts, roles, OAuth" },
  { name: "files", description: "File storage, sharing and blobs" },
  { name: "webhooks", description: "Webhook endpoints and deliveries" },
  { name: "notifications", description: "Notifications and their delivery" },
  { name: "audit", description: "Audit log entries" },
  {
    name: "provisioning",
    description: "Provisioning documents, services and the registry",
  },
  { name: "platform", description: "Health, setup, UI, startup and shutdown" },
  { name: "race", description: "Concurrent requests or processes" },
  { name: "job", description: "Background jobs and schedulers" },
  { name: "security", description: "Security properties and attack paths" },
  {
    name: "slow",
    description: "Takes long; raises the test timeout",
    timeout: 120_000,
  },
  { name: "redis-outage", description: "Behaviour while Redis is unavailable" },
];

/**
 * Areas a test file may carry, by path under `src/tests`. The longest
 * matching prefix wins; a path matching none accepts any area.
 */
export const AREA_BY_PATH: ReadonlyArray<
  readonly [prefix: string, area: AreaTag]
> = [
  ["routes/oauth", "auth"],
  ["routes/well-known", "auth"],
  ["routes/v1/account", "auth"],
  ["routes/v1/admin", "auth"],
  ["routes/v1/admin/notifications", "notifications"],
  ["routes/v1/admin/services", "provisioning"],
  ["utils/provisioning", "provisioning"],
  ["cli/provision", "provisioning"],
  ["routes/v1/files", "files"],
  ["routes/v1/webhooks", "webhooks"],
  ["routes/v1/notifications", "notifications"],
  ["utils/notifications", "notifications"],
  ["routes/v1/audit", "audit"],
  ["utils/identityProviders", "auth"],
  ["routes/health", "platform"],
  ["routes/v1/setup", "platform"],
  ...AREA_TAGS.map((a) => [`flows/${a}`, a] as const),
];
