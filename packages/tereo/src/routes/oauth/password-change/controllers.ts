import { getDefaultOrganizationId } from "../../../utils/defaultOrganization.js";
import { passwordChangeFailure } from "../../../middleware/rateLimit.js";
import { BadRequestError, OAuth2Error } from "../../../utils/errors.js";
import { hashPassword, verifyPassword } from "../../../utils/crypto.js";
import { recordSessionsRevoked } from "../../../utils/sessionEvents.js";
import { emitTx, logAuditTx } from "../../../utils/outbox.js";
import { validateBody } from "../../../utils/validateReq.js";
import { endUserSessions } from "../../../utils/sessions.js";
import { hashTotpSetupGrant } from "../../../utils/totp.js";
import { PasswordChangeSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  clearPasswordChangeGrantCookie,
  getPasswordChangeGrantFromCookie,
} from "../../../utils/cookies.js";

const invalidGrant = () =>
  new OAuth2Error(
    "invalid_change_grant",
    "Invalid or expired link. Please login again."
  );

export const passwordChangeHandler = async (req: Request, res: Response) => {
  const body = validateBody(PasswordChangeSchema, req);
  await passwordChangeFailure.check(req);

  const grant = await db.passwordChangeGrants.get(
    hashTotpSetupGrant(body.change_grant)
  );
  if (!grant) throw invalidGrant();

  const client = await db.clients.get(grant.clientId);
  // The cookie is set alongside the grant, so a grant lifted from a URL is
  // useless outside the browser that passed the password check.
  if (
    getPasswordChangeGrantFromCookie(req, client.clientId) !== body.change_grant
  ) {
    throw invalidGrant();
  }

  if (grant.expiresAt < new Date()) {
    await db.passwordChangeGrants.consume(grant.id);
    clearPasswordChangeGrantCookie(res, client.clientId);
    throw new OAuth2Error(
      "change_expired",
      "Password change link expired. Please login again."
    );
  }

  const user = await db.users.get(grant.userId);
  if (!user.isActive || !user.passwordHash || !user.passwordChangeRequired) {
    await db.passwordChangeGrants.consume(grant.id);
    clearPasswordChangeGrantCookie(res, client.clientId);
    throw invalidGrant();
  }

  if (await verifyPassword(user.passwordHash, body.password)) {
    throw new BadRequestError(
      "password_unchanged",
      "The new password must differ from the current one"
    );
  }

  const passwordHash = await hashPassword(body.password);
  const actor = { userId: user.id, email: user.email };
  const recordRevoked = recordSessionsRevoked(actor, user, { self: true });
  // The grant is consumed in the transaction that ends the user's other
  // sessions, which holds the user's row: a grant used twice, or one a
  // concurrent session end deleted, rolls the change back.
  await endUserSessions(
    user.id,
    null,
    async (tx, sessionIds, ssoSessionIds) => {
      if (!(await db.passwordChangeGrants.consume(grant.id, tx))) {
        throw invalidGrant();
      }
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangeRequired: false },
      });
      await logAuditTx(tx, {
        auth: actor,
        action: "UPDATE",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: { action: "password_changed", forced: true },
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

  await passwordChangeFailure.reset(req);
  clearPasswordChangeGrantCookie(res, client.clientId);
  res.status(204).end();
};
