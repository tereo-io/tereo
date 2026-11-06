import { getDefaultOrganizationId } from "../../../utils/defaultOrganization.js";
import { recordSessionsRevoked } from "../../../utils/sessionEvents.js";
import { passwordSetupFailure } from "../../../middleware/rateLimit.js";
import { hashPassword, hashFlowToken } from "../../../utils/crypto.js";
import { isAccountUsable } from "../../../utils/passwordSetup.js";
import { emitTx, logAuditTx } from "../../../utils/outbox.js";
import { endUserSessions } from "../../../utils/sessions.js";
import { validateBody } from "../../../utils/validateReq.js";
import { NotFoundError } from "../../../utils/errors.js";
import { SetPasswordSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";

/**
 * The live token and its user, or the one 404 every miss gets: unknown, used
 * or expired token, and a user no longer usable, so a probe learns nothing.
 * A miss counts against the caller's IP.
 */
export const findUsableSetupToken = async (req: Request, token: string) => {
  const found = await db.passwordSetupTokens.findLiveByHash(
    hashFlowToken(token)
  );
  if (!found || !isAccountUsable(found.user)) {
    await passwordSetupFailure.recordFailure(req);
    throw new NotFoundError("Not found");
  }
  return found;
};

/**
 * Sets the password from a setup link and signs the user out everywhere, in
 * one transaction: the token is consumed with a conditional update, so of
 * two concurrent requests with one token exactly one wins.
 */
export const setPassword = async (req: Request, res: Response) => {
  const { token, password } = validateBody(SetPasswordSchema, req);
  await passwordSetupFailure.assertUnderLimit(req);
  const { id: tokenId, user } = await findUsableSetupToken(req, token);
  const passwordHash = await hashPassword(password);
  const recordRevoked = recordSessionsRevoked(
    { userId: user.id, email: user.email },
    user
  );

  await endUserSessions(
    user.id,
    null,
    async (tx, sessionIds, ssoSessionIds) => {
      // The user's row is locked: a deactivation or expiry since the lookup
      // shows here.
      const current = await db.users.get(user.id, tx);
      if (
        !isAccountUsable(current) ||
        !(await db.passwordSetupTokens.consume(tokenId, tx))
      ) {
        await passwordSetupFailure.recordFailure(req);
        throw new NotFoundError("Not found");
      }
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangeRequired: false },
      });
      await logAuditTx(tx, {
        auth: { userId: user.id, email: user.email },
        action: "UPDATE",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: { action: "password_set_from_link" },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.user.password-set",
        entityType: "User",
        entityId: user.id,
        data: { userId: user.id, email: user.email },
      });
      await recordRevoked(tx, sessionIds, ssoSessionIds);
    }
  );

  res.status(204).end();
};
