import { emitTx, logAuditTx, type AuditLogInput } from "../outbox.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
import { endUserSessions, type Caller } from "../sessions.js";
import { recordSessionsRevoked } from "../sessionEvents.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { Prisma } from "../db/prisma.js";
import { emailDomain } from "../email.js";
import db from "../db/index.js";

interface IdentityRow {
  id: string;
  email: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  provider: { slug: string; displayName: string };
}

export const formatUserIdentity = (identity: IdentityRow) => ({
  id: identity.id,
  provider: {
    slug: identity.provider.slug,
    displayName: identity.provider.displayName,
  },
  email: identity.email,
  createdAt: identity.createdAt.toISOString(),
  lastLoginAt: identity.lastLoginAt?.toISOString() ?? null,
});

/**
 * Removes one of the user's identities, unless it is their last way in or
 * their email's domain must sign in through its provider, and in the same
 * transaction ends the user's sessions, the caller's own excepted: one
 * obtained through the identity must not outlive it, and nothing records
 * which were. Throws NotFoundError for an identity that is not the user's.
 * `prepare` runs first in the transaction, before the user's row is locked.
 */
export const unlinkIdentity = async (
  auth: AuditLogInput["auth"] & Caller,
  userId: string,
  identityId: string,
  prepare?: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<void> => {
  const identity = await db.userIdentities.get(userId, identityId);
  const provider = await db.identityProviders.get(identity.providerId);

  const self = auth.userId === userId;
  await endUserSessions(
    userId,
    self ? auth : null,
    // The user's row is locked: two unlinks at once cannot both find
    // another way in.
    async (tx, sessionIds, ssoSessionIds) => {
      const user = await db.users.get(userId, tx);
      const others = await db.userIdentities.countUsableForUser(
        userId,
        identity.id,
        tx
      );
      if (user.passwordHash === null && others === 0) {
        throw new ConflictError(
          "This is the account's only way to sign in",
          "last_sign_in_method"
        );
      }
      const domain = await db.identityProviders.findDomain(
        emailDomain(user.email),
        tx
      );
      if (domain?.ssoOnly && domain.providerId === provider.id) {
        throw new ConflictError(
          `Accounts at ${domain.domain} must sign in with ${provider.displayName}`,
          "sso_required"
        );
      }

      if (!(await db.userIdentities.delete(identity.id, tx))) {
        throw new NotFoundError("Identity not found");
      }
      await logAuditTx(tx, {
        auth,
        action: "DELETE",
        entityType: "UserIdentity",
        entityId: identity.id,
        entityName: user.email,
        metadata: {
          userId,
          providerId: provider.id,
          provider: provider.slug,
          email: identity.email,
        },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.user.identity-unlinked",
        entityType: "UserIdentity",
        entityId: identity.id,
        data: {
          id: identity.id,
          userId,
          providerId: provider.id,
          provider: provider.slug,
          email: identity.email,
        },
      });
      await recordSessionsRevoked(auth, user, { self })(
        tx,
        sessionIds,
        ssoSessionIds
      );
    },
    prepare
  );
};
