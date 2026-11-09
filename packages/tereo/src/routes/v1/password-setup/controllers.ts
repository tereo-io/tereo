import { getDefaultOrganizationId } from "../../../utils/defaultOrganization.js";
import { PASSWORD_LINK_PURPOSES } from "../../../utils/db/userLinkTokens.js";
import { recordSessionsRevoked } from "../../../utils/sessionEvents.js";
import { hashPassword, hashFlowToken } from "../../../utils/crypto.js";
import { canResetPassword } from "../../../utils/passwordReset.js";
import { markEmailVerified } from "../../../utils/userLinks.js";
import { emitTx, logAuditTx } from "../../../utils/outbox.js";
import { endUserSessions } from "../../../utils/sessions.js";
import { validateBody } from "../../../utils/validateReq.js";
import { isUsableAccount } from "../../../utils/users.js";
import { NotFoundError } from "../../../utils/errors.js";
import { emailDomain } from "../../../utils/email.js";
import { logger } from "../../../utils/logger.js";
import { SetPasswordSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  UserType,
  type Prisma,
} from "../../../../prisma/generated/client/index.js";
import {
  loginAccountBackoff,
  passwordSetupFailure,
} from "../../../middleware/rateLimit.js";

type PasswordLinkPurpose = (typeof PASSWORD_LINK_PURPOSES)[number];

type LinkUser = {
  email: string;
  isActive: boolean;
  expiresAt: Date | null;
  userType: UserType;
};

const isPasswordLinkPurpose = (value: string): value is PasswordLinkPurpose =>
  (PASSWORD_LINK_PURPOSES as readonly string[]).includes(value);

/**
 * Whether a link of the purpose still reaches the user. Setup links are for
 * guests: once promoted, the account is a regular user's, and a link the
 * inviter saw must not reach it. Reset links reach any account a reset may
 * be sent for. Neither reaches an address on an SSO-only domain, where the
 * provider holds the credential.
 */
const isRedeemable = async (
  purpose: PasswordLinkPurpose,
  user: LinkUser,
  tx?: Prisma.TransactionClient
) => {
  const domain = await db.identityProviders.findDomain(
    emailDomain(user.email),
    tx
  );
  const ssoOnly = domain?.ssoOnly ?? false;
  if (purpose === "setup") {
    return (
      isUsableAccount(user) && user.userType === UserType.guest && !ssoOnly
    );
  }
  return canResetPassword(user, ssoOnly);
};

/**
 * The live token and its user, or the one 404 every miss gets: unknown, used
 * or expired token, and a user the link no longer reaches, so a probe learns
 * nothing. A miss counts against the caller's IP.
 */
export const findUsableSetupToken = async (req: Request, token: string) => {
  const found = await db.userLinkTokens.findLiveByHash(
    hashFlowToken(token),
    PASSWORD_LINK_PURPOSES
  );
  if (
    !found ||
    !isPasswordLinkPurpose(found.purpose) ||
    !(await isRedeemable(found.purpose, found.user))
  ) {
    await passwordSetupFailure.recordFailure(req);
    throw new NotFoundError("Not found");
  }
  return { ...found, purpose: found.purpose };
};

/**
 * Sets the password from a setup or reset link and signs the user out everywhere, in
 * one transaction: the token is consumed with a conditional update, so of
 * two concurrent requests with one token exactly one wins.
 */
export const setPassword = async (req: Request, res: Response) => {
  const { token, password } = validateBody(SetPasswordSchema, req);
  await passwordSetupFailure.assertUnderLimit(req);
  const { id: tokenId, user, purpose } = await findUsableSetupToken(req, token);
  const passwordHash = await hashPassword(password);
  const recordRevoked = recordSessionsRevoked(
    { userId: user.id, email: user.email },
    user
  );

  await endUserSessions(
    user.id,
    null,
    async (tx, sessionIds, ssoSessionIds) => {
      // The user's row is locked: a deactivation, expiry, promotion or
      // SSO-only domain since the lookup shows here.
      const current = await db.users.get(user.id, tx);
      if (
        !(await isRedeemable(purpose, current, tx)) ||
        !(await db.userLinkTokens.consume(tokenId, tx))
      ) {
        await passwordSetupFailure.recordFailure(req);
        throw new NotFoundError("Not found");
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangeRequired: false,
          passwordSetByUser: true,
        },
      });
      await logAuditTx(tx, {
        auth: { userId: user.id, email: user.email },
        action: "UPDATE",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: { action: "password_set_from_link", via: purpose },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.user.password-set",
        entityType: "User",
        entityId: user.id,
        data: { userId: user.id, email: user.email, via: purpose },
      });
      // A reset link only ever goes to the inbox. A setup link's URL is
      // returned to the inviter, so redeeming it proves nothing about the
      // address.
      if (purpose === "reset") {
        await markEmailVerified(tx, {
          userId: user.id,
          via: "password_link",
          email: user.email,
        });
      }
      // A grant from a sign-in with the old password must not outlive it.
      await db.passwordChangeGrants.deleteForUser(user.id, tx);
      await recordRevoked(tx, sessionIds, ssoSessionIds);
    }
  );

  // A reset proved the inbox, so the account's own backoff from the failed
  // sign-ins before it goes. The per-client-and-IP failure window
  // (authFailure) is shared with other accounts and stays, for up to its 5
  // minutes.
  if (purpose === "reset") {
    await loginAccountBackoff
      .reset(req, user.email)
      .catch((err) =>
        logger.warn({ err }, "Could not clear the login backoff after a reset")
      );
  }

  res.status(204).end();
};
