// ---------------------------------------------------------------------------
// Organization — returned by `GET /v1/admin/organizations/:id` and
// `GET /v1/admin/organizations/default` via `formatOrganization()`.
// ---------------------------------------------------------------------------

/**
 * Admin organization representation.
 *
 * Shape is produced by `formatOrganization()` in
 * `packages/tereo/src/utils/transformers.ts`. The underlying Prisma
 * `Organization` model has an `archivedAt` lifecycle column; operational
 * queries exclude archived rows, while admin reads surface `archivedAt`
 * (below) so archived orgs remain viewable by id.
 *
 * Note: core has no concept of parent organizations, owner users,
 * quota limits, or free-form metadata/settings on an organization — those
 * responsibilities sit in other services (e.g., Inventory). Only the fields
 * below are serialized by the admin endpoints.
 */
export interface AuthServiceOrganization {
  /** Stable UUIDv7 — same value carried in JWT `org_id` claim. */
  id: string;
  name: string;
  slug: string;
  /** 6-character short code. */
  code: string;
  isDefault: boolean;
  isActive: boolean;
  /** ISO-8601 timestamp set when the organization is archived; null while live. */
  archivedAt: string | null;
  /** Count of rows in `organization_members` for this org. */
  memberCount: number;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}
