import { getDefaultOrganizationId } from "../../../utils/defaultOrganization.js";
import { BadRequestError, NotFoundError } from "../../../utils/errors.js";
import { beginPasswordAttempt } from "../../../utils/passwordAttempts.js";
import { hashPassword, verifyPassword } from "../../../utils/crypto.js";
import { recordSessionsRevoked } from "../../../utils/sessionEvents.js";
import { presignUserPhotoUrl } from "../../../utils/userPhotos.js";
import { retirePasswordLinks } from "../../../utils/userLinks.js";
import { emitTx, logAuditTx } from "../../../utils/outbox.js";
import { validateBody } from "../../../utils/validateReq.js";
import { endUserSessions } from "../../../utils/sessions.js";
import { validateUser } from "../../../utils/auth.js";
import { prisma } from "../../../utils/db/prisma.js";
import { ChangePasswordSchema } from "./schemas.js";
import { logger } from "../../../utils/logger.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  accountPasswordFailure,
  loginAccountBackoff,
} from "../../../middleware/rateLimit.js";

export const getProfile = async (req: Request, res: Response) => {
  const { userId, organizationId } = validateUser(req);

  const user = await db.users.get(userId);
  // The token's scope: global roles, and its organization's when it has one.
  const userRoles = await db.roles.getLiveUserRoles(userId, organizationId);
  const permissions = await db.roles.getUserPermissions(userId, organizationId);
  const totpStatus = await db.totp.getUserTotpStatus(userId);
  const photoObjectId = await db.users.getProfilePhotoId(userId);
  const photoUrl = photoObjectId
    ? await presignUserPhotoUrl(photoObjectId)
    : null;

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    isActive: user.isActive,
    hasPassword: user.passwordHash !== null,
    emailVerified: user.emailVerifiedAt !== null,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    photoUrl,
    roles: userRoles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      displayName: ur.role.displayName,
      expiresAt: ur.expiresAt?.toISOString() ?? null,
    })),
    permissions,
    totp: {
      enabled: totpStatus.totpEnabled,
      enabledAt: totpStatus.totpEnabledAt?.toISOString() ?? null,
      required: totpStatus.totpRequired,
      recoveryCodesRemaining: totpStatus.recoveryCodesRemaining,
    },
  });
};

export const changePassword = async (req: Request, res: Response) => {
  const caller = validateUser(req);
  const { userId } = caller;
  const body = validateBody(ChangePasswordSchema, req);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, passwordHash: true },
  });

  if (!user) throw new NotFoundError("User not found");
  if (!user.passwordHash) {
    throw new BadRequestError("no_password", "This account has no password");
  }
  await accountPasswordFailure.check(req);
  // The account's backoff at sign-in: a token for the account must not be a
  // faster way to guess its password than the login page.
  await loginAccountBackoff.check(req, user.email);

  const isCurrentPasswordValid = await verifyPassword(
    user.passwordHash,
    body.currentPassword
  );

  const attempt = beginPasswordAttempt(req, user, "password_change");
  if (!isCurrentPasswordValid) {
    await attempt.failed("invalid_password");
    throw new BadRequestError(
      "invalid_password",
      "Current password is incorrect"
    );
  }
  await accountPasswordFailure.reset(req);
  await loginAccountBackoff.reset(req, user.email);
  await attempt.succeeded();

  if (body.currentPassword === body.newPassword) {
    throw new BadRequestError(
      "same_password",
      "New password must be different from current password"
    );
  }

  const newPasswordHash = await hashPassword(body.newPassword);

  // A password change must invalidate every other session: users change
  // passwords precisely to lock out a suspected attacker, so leaving stolen
  // tokens or SSO cookies valid defeats the purpose. The current session and
  // its browser are preserved so the caller isn't logged out of this tab.
  // The password changes in the transaction that ends them, as an admin
  // reset does, so no session outlives the old password.
  const actor = { userId: user.id, email: user.email };
  const recordRevoked = recordSessionsRevoked(actor, user, { self: true });
  const revoked = await endUserSessions(
    userId,
    caller,
    async (tx, sessionIds, ssoSessionIds) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: newPasswordHash, passwordSetByUser: true },
      });
      // A setup link issued before would replace the password just chosen.
      await retirePasswordLinks(tx, userId);
      await logAuditTx(tx, {
        auth: actor,
        action: "UPDATE",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: { action: "password_changed" },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.user.password-changed",
        entityType: "User",
        entityId: user.id,
        data: { userId: user.id, email: user.email },
      });
      await recordRevoked(tx, sessionIds, ssoSessionIds);
    }
  );

  logger.debug(
    { userId, revokedSessions: revoked.length },
    "User changed password"
  );

  res.json({
    success: true,
    message: "Password changed successfully",
  });
};
