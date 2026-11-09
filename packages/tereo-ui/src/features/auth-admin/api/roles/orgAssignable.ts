import type { Role } from "./types";

/**
 * The roles that may be offered within an organization, directly or through
 * one of its groups. Core refuses system roles (403) and a newly added role
 * carrying a permission that is neither org-assignable nor retired (400).
 * Inactive roles are never offered. A role in `held` skips only the
 * permission test, since core keeps a held role whatever its permissions.
 * A held role left out here (inactive, or archived and so never fetched) is
 * for the caller to lock and send back: the PUT replaces the whole set.
 */
export const orgAssignableRoles = (
  roles: Role[],
  held: ReadonlySet<string>
): Role[] =>
  roles.filter(
    (r) =>
      !r.isSystem &&
      r.isActive &&
      (held.has(r.id) ||
        (r.permissions ?? []).every((p) => p.retired || p.orgAssignable))
  );
