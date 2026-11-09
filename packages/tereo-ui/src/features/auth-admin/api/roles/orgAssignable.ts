import type { Role } from "./types";

/**
 * The roles that may be held within an organization, directly or through
 * one of its groups. Core refuses system roles (403) and a newly added role
 * carrying a permission that is neither org-assignable nor retired (400);
 * a role in `held` stays listed whatever its permissions, so saving keeps it.
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
