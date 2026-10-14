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
}

/** Role assignment shape returned by `GET /v1/admin/users/:id/roles`. */
export interface AuthServiceUserRole {
  /** Role ID. */
  id: string;
  /** Role name (slug). */
  name: string;
  /** Human-readable role name. */
  displayName: string;
  /** ISO-8601 timestamp, or null if the role assignment is permanent. */
  expiresAt: string | null;
}

/** Response shape of `GET /v1/admin/users/:id/permissions`. */
export interface AuthServiceUserPermissionsResponse {
  userId: string;
  /** Flat list of permission names, e.g. `"users.read"`. */
  permissions: string[];
}
