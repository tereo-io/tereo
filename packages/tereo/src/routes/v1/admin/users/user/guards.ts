import { globalGrantablePermissions } from "../../../../../utils/grants.js";
import type { AuthContext } from "../../../../../middleware/auth.js";
import { SYSTEM_USER_ID } from "../../../../../definitions/index.js";
import { hasPermission } from "../../../../../utils/permissions.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import db from "../../../../../utils/db/index.js";
import {
  BadRequestError,
  ForbiddenError,
} from "../../../../../utils/errors.js";

/** Core's system user is seed-managed; the admin API cannot change it. */
export const assertNotSystemUser = (id: string) => {
  if (id === SYSTEM_USER_ID) {
    throw new BadRequestError(
      "system_user",
      "The system user is managed by core and cannot be modified"
    );
  }
};

/**
 * A service's or an integration's account is managed with it, under
 * /admin/services or /admin/integrations.
 */
export const assertNotServiceAccount = async (user: {
  oauthClientId: string | null;
}) => {
  const owner = user.oauthClientId
    ? await db.services.getByClientId(user.oauthClientId)
    : null;
  if (owner) {
    throw new ForbiddenError(
      owner.kind === "integration"
        ? "This user is an integration's account; manage it under /admin/integrations"
        : "This user is a service account; manage it under /admin/services"
    );
  }
};

/**
 * Refuses acting on a user holding any permission the caller does not. The
 * target's permissions count from every scope (global roles and roles in any
 * organization), deactivated roles included: one can be reactivated, so a
 * suspended admin role still protects its holder. The caller's count from global roles only, since an
 * org-scoped role does not reach beyond its organization while the target's
 * account does — and capped by a delegated token's scopes, so a third-party
 * client cannot act on an account its scopes do not cover.
 */
const assertHoldsTargetPermissions = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  targetId: string,
  action: string,
  tx?: Prisma.TransactionClient
) => {
  const targetPermissions = await db.roles.getUserPermissionsAnywhere(
    targetId,
    tx,
    { includeInactiveRoles: true }
  );
  if (targetPermissions.length === 0) return;
  const callerPermissions = await globalGrantablePermissions(auth, tx);
  const lacking = targetPermissions.filter(
    (p) => !hasPermission(callerPermissions, p)
  );
  if (lacking.length > 0) {
    throw new ForbiddenError(
      `You cannot ${action} a user holding permissions you do not: ${lacking.join(", ")}`
    );
  }
};

/**
 * Refuses a password, email, two-factor or identity reset of a user holding
 * any permission the caller does not: a reset hands the caller the target's
 * account, so it must not reach beyond what the caller already holds.
 */
export const assertMayResetCredentials = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  targetId: string,
  tx?: Prisma.TransactionClient
) =>
  await assertHoldsTargetPermissions(
    auth,
    targetId,
    "change the email, password, two-factor authentication or identities of",
    tx
  );

/**
 * Refuses deactivating, removing roles from or ending any session of a user
 * holding any permission the caller does not: `users.write` or `users.delete`
 * must not be enough to lock out or strip an administrator. Acting on yourself is not checked.
 */
export const assertMayDisempower = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  targetId: string,
  action:
    | "deactivate"
    | "remove roles from"
    | "end a session of"
    | "end all sessions of",
  tx?: Prisma.TransactionClient
) => {
  if (targetId === auth.userId) return;
  await assertHoldsTargetPermissions(auth, targetId, action, tx);
};
