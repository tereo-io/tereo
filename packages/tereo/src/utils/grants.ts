import type { AuthContext } from "../middleware/auth.js";
import { hasPermission } from "./permissions.js";
import { capToCeiling } from "./coreAccess.js";
import { ForbiddenError } from "./errors.js";
import type { Prisma } from "./db/prisma.js";
import db from "./db/index.js";

const notHeld = (callerPermissions: string[], names: Iterable<string>) =>
  [...new Set(names)]
    .filter((p) => !hasPermission(callerPermissions, p))
    .sort();

/**
 * Only grant what you hold: a caller may give a user, a role or a service
 * only permissions their own token carries (`admin` carries all). What a
 * target already has is the caller's to keep, not to grant, so callers pass
 * only what is new.
 */
export const assertCanGrant = (
  callerPermissions: string[],
  granted: Iterable<string>
): void => {
  const beyond = notHeld(callerPermissions, granted);
  if (beyond.length > 0) {
    throw new ForbiddenError(
      `You cannot grant permissions you do not hold: ${beyond.join(", ")}`
    );
  }
};

/**
 * The same bound for taking away: changing a role (deleting, deactivating or
 * dropping permissions from it) strips its permissions from every holder at
 * once, so the caller must hold each permission it removes.
 */
export const assertCanTakeAway = (
  callerPermissions: string[],
  removed: Iterable<string>
): void => {
  const beyond = notHeld(callerPermissions, removed);
  if (beyond.length > 0) {
    throw new ForbiddenError(
      `You cannot take away permissions you do not hold: ${beyond.join(", ")}`
    );
  }
};

/**
 * What the caller may grant globally (a global role, a role's permissions, a
 * service's role): their global roles' permissions, capped by a delegated
 * token's ceiling. `auth.permissions` also carries the token organization's
 * roles, which reach only that organization and so must not be handed out
 * everywhere.
 */
export const globalGrantablePermissions = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  tx?: Prisma.TransactionClient
): Promise<string[]> =>
  capToCeiling(
    await db.roles.getUserPermissions(auth.userId, null, tx),
    auth.ceiling
  );
