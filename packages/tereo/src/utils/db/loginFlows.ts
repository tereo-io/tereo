import { Prisma } from "../../../prisma/generated/client/index.js";
import { lockForTokenIssue } from "./users.js";
import { prisma } from "./prisma.js";

/** Writes a login step with the transaction it hands `write`. */
export type StepWriter = <T>(
  write: (tx: Prisma.TransactionClient) => Promise<T>
) => Promise<T>;

/** A step in a transaction of its own. */
export const writeStep: StepWriter = (write) => prisma.$transaction(write);

/**
 * A step written in the transaction that consumes the one before it
 * (`consume`, which throws when that one is gone), holding the user's row as
 * a token issue does. A session end deletes the user's steps holding the row
 * exclusively: either it came first and `consume` finds nothing, or it waits
 * and deletes the step written here.
 */
export const writeStepConsuming =
  (
    userId: string,
    consume: (tx: Prisma.TransactionClient) => Promise<void>
  ): StepWriter =>
  (write) =>
    prisma.$transaction(async (tx) => {
      await lockForTokenIssue(userId, tx);
      await consume(tx);
      return write(tx);
    });

/**
 * Deletes the user's login steps already past the first factor: consent and
 * organization picks, TOTP verifications, 2FA setup grants and the setups
 * they started, identity link grants. Consent for an org switch of
 * `keepUserSessionId` stays. Setups begun from the account page belong to a
 * signed-in token instead, which the caller revokes or keeps.
 */
export const deletePendingForUser = async (
  userId: string,
  keepUserSessionId: string | null,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.consentSession.deleteMany({
    where: {
      userId,
      ...(keepUserSessionId && {
        OR: [
          { userSessionId: null },
          { userSessionId: { not: keepUserSessionId } },
        ],
      }),
    },
  });
  await tx.orgSelectionSession.deleteMany({ where: { userId } });
  await tx.totpVerification.deleteMany({ where: { userId } });
  await tx.totpSetupGrant.deleteMany({ where: { userId } });
  await tx.totpSetupSession.deleteMany({
    where: { userId, clientId: { not: null } },
  });
  await tx.identityLinkGrant.deleteMany({ where: { userId } });
};
