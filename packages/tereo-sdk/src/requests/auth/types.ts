/**
 * Response types for core's admin API (port 4001).
 *
 * Sources of truth:
 *   - packages/tereo/openapi/auth/openapi.yaml
 *   - packages/tereo/prisma/schema.prisma
 *   - packages/tereo/src/utils/transformers.ts (formatUser, formatOrganization)
 *
 * These shapes reflect what the admin GET endpoints actually serialize — extra
 * relations such as roles/permissions/memberships are exposed via separate
 * sibling endpoints (`/v1/admin/users/:id/roles`, `/v1/admin/users/:id/permissions`,
 * `/v1/admin/organizations/:id/members`, etc.) and their response shapes are
 * captured below as nested/auxiliary types so callers have a single place to
 * reference the full admin contract.
 */

// ---------------------------------------------------------------------------
// Enums (mirror Prisma enums and OpenAPI constrained strings)
// ---------------------------------------------------------------------------

/** Prisma `UserType` enum — see schema.prisma. */
export type AuthServiceUserType = "human" | "service_account";

/** Prisma `OrgMemberRole` enum — see schema.prisma. */
export type AuthServiceOrgMemberRole = "owner" | "admin" | "member";

/** Prisma `ClientType` enum — see schema.prisma. */
export type AuthServiceClientType = "confidential" | "public";

/** System-wide TOTP enforcement policy — see SystemSettings schema. */
export type AuthServiceTotpPolicy = "disabled" | "optional" | "required";
