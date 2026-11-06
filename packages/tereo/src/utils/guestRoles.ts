import { isGuestAllowedCorePermission } from "../definitions/guests.js";
import { PERMISSION_CATALOG } from "../definitions/index.js";
import { BadRequestError } from "./errors.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";

const CORE_PERMISSION_NAMES = new Set(PERMISSION_CATALOG.map((p) => p.name));

export const isCorePermission = (name: string): boolean =>
  CORE_PERMISSION_NAMES.has(name);

interface PermissionFacts {
  name: string;
  orgAssignable: boolean;
  retiredAt: Date | null;
  isCore: boolean;
}

/**
 * The permissions that keep a role from being guest-assignable: every live
 * one must be org-assignable, and core's only from the guest floor. Names,
 * sorted; empty when the role qualifies.
 */
export const guestAssignableProblems = (
  permissions: PermissionFacts[]
): string[] =>
  [
    ...new Set(
      permissions
        .filter((p) => !p.retiredAt)
        .filter(
          (p) =>
            !p.orgAssignable ||
            (p.isCore && !isGuestAllowedCorePermission(p.name))
        )
        .map((p) => p.name)
    ),
  ].sort();

export const guestAssignableProblemsOf = (
  permissions: {
    name: string;
    orgAssignable: boolean;
    retiredAt: Date | null;
  }[]
): string[] =>
  guestAssignableProblems(
    permissions.map((p) => ({ ...p, isCore: isCorePermission(p.name) }))
  );

export const assertGuestAssignable = (
  permissions: {
    name: string;
    orgAssignable: boolean;
    retiredAt: Date | null;
  }[]
) => {
  const problems = guestAssignableProblemsOf(permissions);
  if (problems.length > 0) {
    throw new BadRequestError(
      "role_not_guest_assignable",
      `A guest-assignable role may hold only org-assignable permissions, and of core's only the guest ones; remove: ${problems.join(", ")}`
    );
  }
};

export const GUEST_DEFAULT_ROLES_KEY = "guestDefaultRoles";

/** Ids of the roles a new guest gets when the invitation names none. */
export const getGuestDefaultRoleIds = async (
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const all = await db.settings.getAll(tx);
  const value = all[GUEST_DEFAULT_ROLES_KEY];
  return Array.isArray(value) ? (value as string[]) : [];
};
