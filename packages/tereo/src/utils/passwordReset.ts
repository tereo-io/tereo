import { isSsoOnlyEmail, issuePasswordLink, lockUser } from "./userLinks.js";
import { UserType } from "../../prisma/generated/client/index.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { isUsableAccount } from "./users.js";
import { ConflictError } from "./errors.js";
import { emailDomain } from "./email.js";
import { prisma } from "./db/prisma.js";
import db from "./db/index.js";

/**
 * Whether a password reset may be sent for the user: a usable human or guest
 * whose address is not on an SSO-only domain. A user with no password yet
 * (one who signs in through a provider) qualifies.
 */
export const canResetPassword = (
  user: { isActive: boolean; expiresAt: Date | null; userType: UserType },
  ssoOnly: boolean
): boolean =>
  isUsableAccount(user) &&
  (user.userType === UserType.human || user.userType === UserType.guest) &&
  !ssoOnly;

/**
 * Emails a reset link to the address if an eligible account has it. Returns
 * the same way for every address: the route answers 202 either way.
 */
export const requestPasswordReset = async ({
  email,
  clientId,
  ip,
}: {
  email: string;
  clientId?: string;
  ip?: string;
}): Promise<void> => {
  const user = await db.users.getByEmail(email);
  if (!user || user.id === SYSTEM_USER_ID) return;
  const domain = await db.identityProviders.findDomain(emailDomain(user.email));
  if (!canResetPassword(user, domain?.ssoOnly ?? false)) return;

  // Without a connection the mail would be queued and never leave.
  if (!(await db.notificationConnections.getDefault("email"))) return;

  // Only a client that exists goes into the link, so the page cannot be made
  // to carry an arbitrary identifier.
  const knownClient =
    clientId !== undefined && (await db.clients.clientIdExists(clientId));

  try {
    await prisma.$transaction(async (tx) => {
      // The checks above ran unlocked: a deactivation or email change that
      // committed since then retired the user's links and must not be undone.
      await lockUser(tx, user.id);
      const current = await db.users.get(user.id, tx);
      if (
        !current ||
        current.email !== user.email ||
        !canResetPassword(current, await isSsoOnlyEmail(current.email, tx))
      ) {
        return;
      }
      await issuePasswordLink(tx, {
        userId: user.id,
        purpose: "reset",
        createdBy: SYSTEM_USER_ID,
        notify: true,
        clientId: knownClient ? clientId : undefined,
        requestIp: ip,
      });
    });
  } catch (err) {
    // The connection was removed since the check above.
    if (!(err instanceof ConflictError && err.code === "email_not_configured"))
      throw err;
  }
};
