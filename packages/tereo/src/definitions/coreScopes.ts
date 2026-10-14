import { CORE_SERVICE } from "./coreService.js";

/**
 * Core's own audience: its service slug, the same namespace app services'
 * audiences use. Core puts it on an access token exactly when the grant
 * includes a core API scope.
 */
export const CORE_AUDIENCE = CORE_SERVICE.slug;

/**
 * The parts of core's API a token may be admitted to, one per router.
 * `notifications` has no scope: only core's UI and services reach it.
 */
export type CoreArea =
  | "account"
  | "admin"
  | "audit"
  | "files"
  | "registry"
  | "webhooks"
  | "notifications";

export interface CoreScope {
  name: string;
  description: string;
  /** The router the scope opens. */
  area: CoreArea;
  /**
   * The most the scope lets the token do there, as permissions in the usual
   * hierarchy (`x.admin` covers `x.*`). A token's rights are the user's live
   * permissions cut down to what its scopes' ceilings cover.
   */
  ceiling: string[];
}

const ADMIN_DOMAINS = [
  "users",
  "roles",
  "permissions",
  "clients",
  "settings",
  "organizations",
  "services",
];

/**
 * Scopes a client other than core's own UI or a service needs to call core's
 * API for its user. Two per area — everything the user may do there, or only
 * reading — and one for the user's own account. `/registry` has none: only
 * services declare.
 */
export const CORE_SCOPES: readonly CoreScope[] = [
  {
    name: "core:account",
    description:
      "Manage your account: profile, password, sessions and two-factor authentication",
    area: "account",
    ceiling: [],
  },
  {
    name: "core:admin",
    description:
      "Administer users, roles, organizations, clients and settings as you can",
    area: "admin",
    ceiling: ADMIN_DOMAINS.map((d) => `${d}.admin`),
  },
  {
    name: "core:admin.read",
    description:
      "View users, roles, organizations, clients and settings you can see",
    area: "admin",
    ceiling: ADMIN_DOMAINS.map((d) => `${d}.read`),
  },
  {
    name: "core:files",
    description: "Read, upload, share and delete files as you can",
    area: "files",
    ceiling: ["file-service.admin"],
  },
  {
    name: "core:files.read",
    description: "Read files you can read",
    area: "files",
    ceiling: [
      "file-service.buckets.read",
      "file-service.objects.read",
      "file-service.permissions.read",
      "file-service.shares.read",
    ],
  },
  {
    name: "core:audit",
    description: "Read and write audit log entries as you can",
    area: "audit",
    ceiling: ["audit-logs.admin"],
  },
  {
    name: "core:audit.read",
    description: "Read audit log entries you can read",
    area: "audit",
    ceiling: ["audit-logs.read"],
  },
  {
    name: "core:webhooks",
    description: "Manage webhook endpoints and deliveries as you can",
    area: "webhooks",
    ceiling: ["webhooks.admin"],
  },
  {
    name: "core:webhooks.read",
    description: "View webhook endpoints and deliveries you can see",
    area: "webhooks",
    ceiling: ["webhooks.read", "webhooks.event-types.read"],
  },
];

const BY_NAME = new Map(CORE_SCOPES.map((s) => [s.name, s]));

/** The core API scopes among a token's scopes. */
export const coreScopesOf = (scopes: string[]): CoreScope[] =>
  scopes.flatMap((name) => BY_NAME.get(name) ?? []);
