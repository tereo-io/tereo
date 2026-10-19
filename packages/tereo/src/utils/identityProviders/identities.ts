import { emitTx, logAuditTx, type AuditLogInput } from "../outbox.js";
import { getDefaultOrganizationId } from "../defaultOrganization.js";
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
 * their email's domain must sign in through its provider. Throws
 * NotFoundError for an identity that is not the user's. `prepare` runs first
 * in the transaction, before the user's row is locked.
 */
export const unlinkIdentity = async (
  auth: AuditLogInput["auth"],
  userId: string,
  identityId: string,
  prepare?: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<void> => {
  const identity = await db.userIdentities.get(userId, identityId);
  const provider = await db.identityProviders.get(identity.providerId);

  await db.$transaction(async (tx) => {
    await prepare?.(tx);
    // Two unlinks at once must not both find another way in.
    await db.users.lockForSignInChange(userId, tx);
    const user = await db.users.get(userId, tx);
    const remaining = await db.userIdentities.countForUser(userId, tx);
    if (user.passwordHash === null && remaining <= 1) {
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
  });
};
