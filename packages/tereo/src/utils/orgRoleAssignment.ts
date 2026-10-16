import { BadRequestError, ForbiddenError } from "./errors.js";
import type { AuthContext } from "../middleware/auth.js";
import { capToCeiling } from "./coreAccess.js";
import { assertCanGrant } from "./grants.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";

/**
 * Checks that `roleIds` may be given within `organizationId` by the caller,
 * and returns the roles. `alreadyHeld` are role ids the target keeps from
 * before: they stay as they are, and only the newly granted ones are checked.
 */
export const assertOrgAssignableRoles = async (
  auth: Pick<
    AuthContext,
    "userId" | "permissions" | "ceiling" | "organizationId"
  >,
  organizationId: string,
  roleIds: string[],
  alreadyHeld: Set<string>,
  tx?: Prisma.TransactionClient
) => {
  const ids = [...new Set(roleIds)];
  if (ids.length === 0) return [];

  const roles = await db.roles.getByIds(ids, tx);
  if (roles.length !== ids.length) {
    const foundIds = new Set(roles.map((r) => r.id));
    const missingIds = ids.filter((id) => !foundIds.has(id));
    throw new BadRequestError(
      "unknown_role",
      `Roles not found, archived or retired: ${missingIds.join(", ")}`
    );
  }

  // Org-scoped assignment only requires the caller to be an org admin, not a
  // platform permission. System roles carry platform-wide permissions (e.g.
  // the `admin` wildcard, per-service `*.admin`) that getUserPermissions
  // merges into the global permission set when the user authenticates under
  // this org, so attaching one is a path to full platform admin. Only
  // platform admins (roles.write) may manage system-role assignment, via
  // /admin/users.
  const systemRoles = roles.filter((r) => r.serviceId !== null);
  if (systemRoles.length > 0) {
    throw new ForbiddenError(
      `System roles cannot be assigned within an organization: ${systemRoles
        .map((r) => r.name)
        .join(", ")}`
    );
  }

  // A newly granted role may carry only org-assignable permissions, and only
  // ones the caller holds.
  const added = roles.filter((r) => !alreadyHeld.has(r.id));
  const notAssignable = db.roles.notOrgAssignablePermissionNames(added);
  if (notAssignable.length > 0) {
    throw new BadRequestError(
      "not_org_assignable",
      `These permissions cannot be granted within an organization: ${notAssignable.join(", ")}`
    );
  }
  assertCanGrant(
    await callerPermissionsIn(auth, organizationId),
    db.roles.grantedPermissionNames(added)
  );
  return roles;
};

/**
 * What the caller holds in `organizationId`. `auth.permissions` hold in the
 * token's organization only: a role the caller has in another organization
 * must not let them grant in this one.
 */
const callerPermissionsIn = async (
  auth: Pick<
    AuthContext,
    "userId" | "permissions" | "ceiling" | "organizationId"
  >,
  organizationId: string
): Promise<string[]> =>
  organizationId === auth.organizationId
    ? auth.permissions
    : capToCeiling(
        await db.roles.getUserPermissions(auth.userId, organizationId),
        auth.ceiling
      );
