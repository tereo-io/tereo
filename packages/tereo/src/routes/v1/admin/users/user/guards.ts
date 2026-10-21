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

const MANAGES_ORGS = "organizations.write";

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
 * Refuses acting on a user holding any authority the caller does not. The
 * target's permissions count from every scope (global roles and roles in any
 * organization), deactivated roles included: one can be reactivated, so a
 * suspended admin role still protects its holder. The caller's count from
 * global roles only, since an org-scoped role does not reach beyond its
 * organization while the target's account does — and capped by a delegated
 * token's scopes, so a third-party client cannot act on an account its scopes
 * do not cover.
 *
 * An `owner` or `admin` membership is authority no permission names: acting
 * as the target manages that organization. The global equivalent is
 * `organizations.write`, which `requireOrgRole` lets manage any
 * organization's owners and admins, so a target holding such a membership
 * anywhere needs it.
 */
const assertHoldsTargetPermissions = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  targetId: string,
  action: string,
  tx: Prisma.TransactionClient
) => {
  const targetPermissions = await db.roles.getUserPermissionsAnywhere(
    targetId,
    tx,
    { includeInactiveRoles: true }
  );
  const managesOrgs = await db.organizations.hasManagingMembership(
    targetId,
    tx
  );
  if (targetPermissions.length === 0 && !managesOrgs) return;
  const callerPermissions = await globalGrantablePermissions(auth, tx);
  const lacking = targetPermissions.filter(
    (p) => !hasPermission(callerPermissions, p)
  );
  if (lacking.length > 0) {
    throw new ForbiddenError(
      `You cannot ${action} a user holding permissions you do not: ${lacking.join(", ")}`
    );
  }
  if (managesOrgs && !hasPermission(callerPermissions, MANAGES_ORGS)) {
    throw new ForbiddenError(
      `You cannot ${action} an organization owner or admin without ${MANAGES_ORGS}`
    );
  }
};

/**
 * Refuses a password, email, two-factor or identity reset of a user holding
 * any permission the caller does not: a reset hands the caller the target's
 * account, so it must not reach beyond what the caller already holds. Takes
 * the target's authority lock, so it runs first in the reset's transaction and
 * no grant to the target commits between the check and the reset.
 */
export const assertMayResetCredentials = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  targetId: string,
  tx: Prisma.TransactionClient
) => {
  await db.users.lockAuthority(targetId, tx);
  await assertHoldsTargetPermissions(
    auth,
    targetId,
    "change the email, password, two-factor authentication or identities of",
    tx
  );
};

/**
 * Refuses changing the secret of a service's or an integration's client when
 * its account holds any permission the caller does not: a new secret is
 * shown to the caller, who could then act as the account. Takes the
 * account's authority lock, so it runs first in the change's transaction.
 */
export const assertMayTakeOverAccount = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  accountUserId: string,
  tx: Prisma.TransactionClient
) => {
  await db.users.lockAuthority(accountUserId, tx);
  await assertHoldsTargetPermissions(
    auth,
    accountUserId,
    "change the secret of",
    tx
  );
};

/**
 * Refuses deactivating, removing roles from or ending any session of a user
 * holding any permission the caller does not: `users.write` or `users.delete`
 * must not be enough to lock out or strip an administrator. Acting on yourself
 * is not checked. Takes the target's authority lock, as
 * assertMayResetCredentials does.
 */
export const assertMayDisempower = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  targetId: string,
  action:
    | "deactivate"
    | "remove roles from"
    | "end a session of"
    | "end all sessions of",
  tx: Prisma.TransactionClient
) => {
  if (targetId === auth.userId) return;
  await db.users.lockAuthority(targetId, tx);
  await assertHoldsTargetPermissions(auth, targetId, action, tx);
};

/**
 * Refuses reactivating a user holding any authority the caller does not: the
 * account comes back with all of it, as though granted. Takes the target's
 * authority lock, as assertMayResetCredentials does.
 */
export const assertMayReactivate = async (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  targetId: string,
  tx: Prisma.TransactionClient
) => {
  await db.users.lockAuthority(targetId, tx);
  await assertHoldsTargetPermissions(auth, targetId, "reactivate", tx);
};
