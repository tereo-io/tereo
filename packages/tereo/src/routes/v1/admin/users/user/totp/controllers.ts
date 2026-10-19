import { getDefaultOrganizationId } from "../../../../../../utils/defaultOrganization.js";
import { recordSessionsRevoked } from "../../../../../../utils/sessionEvents.js";
import { validateParams } from "../../../../../../utils/validateReq.js";
import { emitTx, logAuditTx } from "../../../../../../utils/outbox.js";
import { endUserSessions } from "../../../../../../utils/sessions.js";
import { BadRequestError } from "../../../../../../utils/errors.js";
import type { Prisma } from "../../../../../../utils/db/prisma.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { logger } from "../../../../../../utils/logger.js";
import db from "../../../../../../utils/db/index.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  assertMayResetCredentials,
  assertNotServiceAccount,
  assertNotSystemUser,
} from "../guards.js";

export const getUserTotpStatus = async (req: Request, res: Response) => {
  const { id } = validateParams(UserIdParamSchema, req);

  await db.users.get(id);
  const status = await db.totp.getUserTotpStatus(id);

  res.json({
    userId: id,
    totpEnabled: status.totpEnabled,
    totpEnabledAt: status.totpEnabledAt?.toISOString() ?? null,
    totpRequired: status.totpRequired,
    recoveryCodesRemaining: status.recoveryCodesRemaining,
  });
};

/**
 * Resets a user's two-factor authentication: TOTP off and recovery codes
 * deleted, so the user enrols again, and every session ended in the same
 * transaction. The admin never sees a code — handing them out would let
 * anyone with users.write sign in past the user's MFA.
 */
export const adminResetUserTotp = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  assertNotSystemUser(id);

  const user = await db.users.get(id);
  await assertNotServiceAccount(user);

  const recordRevoked = recordSessionsRevoked(auth, user);
  const authorize = async (tx: Prisma.TransactionClient) => {
    await assertMayResetCredentials(auth, id, tx);
    if (!(await db.users.get(id, tx)).totpEnabled) {
      throw new BadRequestError(
        "totp_not_enabled",
        "TOTP is not enabled for this user."
      );
    }
  };
  await endUserSessions(
    id,
    null,
    async (tx, sessionIds, ssoSessionIds) => {
      await db.totp.disableTotp(id, tx);
      await logAuditTx(tx, {
        auth,
        action: "UPDATE",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: { action: "totp_reset" },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.user.totp-reset",
        entityType: "User",
        entityId: user.id,
        data: { userId: user.id, email: user.email },
      });
      await recordRevoked(tx, sessionIds, ssoSessionIds);
    },
    authorize
  );

  logger.debug({ userId: id, adminId: auth.userId }, "Admin reset user TOTP");

  res.json({
    success: true,
    message:
      "Two-factor authentication has been reset and the user signed out everywhere. The user must enrol again.",
  });
};
