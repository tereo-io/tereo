import type { GuestStatus } from "../guests/types.js";
import { AuthServiceUserType } from "../types.js";

// ---------------------------------------------------------------------------
// User — returned by `GET /v1/admin/users/:id` via `formatUser()`.
// ---------------------------------------------------------------------------

/**
 * Admin user representation.
 *
 * Shape is produced by `formatUser()` in
 * `packages/tereo/src/utils/transformers.ts` — the underlying Prisma
 * `User` model carries additional columns (passwordHash, totpSecret,
 * firstName, lastName, oauthClientId, photoObjectId, totpEnabled,
 * totpEnabledAt, ...) that are intentionally **not** serialized by the admin
 * endpoint. Fields here are exactly those returned on the wire.
 */
export interface AuthServiceUser {
  /** Stable UUIDv7. */
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  userType: AuthServiceUserType;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  /** ISO-8601 timestamp when the account expires; null for one that never does. */
  expiresAt: string | null;
  /** `expired` only for an account with an expiry that has passed. */
  status: GuestStatus;
  /** Whether the user has confirmed their email address. */
  emailVerified: boolean;
  /** ISO-8601 timestamp of the confirmation; null until then. */
  emailVerifiedAt: string | null;
}

/** A role the user holds directly, as `GET /v1/admin/users/:id/roles` lists it. */
export interface AuthServiceUserRole {
  /** Role ID. */
  id: string;
  /** Role name (slug). */
  name: string;
  /** Human-readable role name. */
  displayName: string;
  /** ISO-8601 timestamp, or null if the role assignment is permanent. */
  expiresAt: string | null;
  /** How the user holds it: assigned to them. */
  via: { kind: "direct" };
}

/** A role the user holds through a group. */
export interface AuthServiceUserGroupRole {
  id: string;
  name: string;
  displayName: string;
  /** The group's organization; null for a global group. */
  organizationId: string | null;
  via: { kind: "group"; groupId: string };
  group: { id: string; slug: string; name: string };
}

/**
 * A role the user holds through an organization's group: it counts only
 * within that organization, while the user is a member there.
 */
export interface AuthServiceUserOrgGroupRole extends AuthServiceUserGroupRole {
  organizationId: string;
  organization: { id: string; name: string };
}

/**
 * Response of `GET` and `PUT /v1/admin/users/:id/roles`. `roles` are the
 * direct assignments (the only ones `PUT` changes); `groupRoles` come from
 * global groups and `orgGroupRoles` from organizations' groups. A role held
 * both ways appears in both lists.
 */
export interface AuthServiceUserRolesResponse {
  userId: string;
  roles: AuthServiceUserRole[];
  groupRoles: AuthServiceUserGroupRole[];
  orgGroupRoles: AuthServiceUserOrgGroupRole[];
}

/** Response shape of `GET /v1/admin/users/:id/permissions`. */
export interface AuthServiceUserPermissionsResponse {
  userId: string;
  /** Flat list of permission names, e.g. `"users.read"`. */
  permissions: string[];
}
