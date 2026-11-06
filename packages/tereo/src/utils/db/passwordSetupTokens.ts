import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export const create = (
  data: Prisma.PasswordSetupTokenUncheckedCreateInput,
  tx: Tx = prisma
) => tx.passwordSetupToken.create({ data });

/** The unused, unexpired token with this hash, with the user it is for. */
export const findLiveByHash = (tokenHash: string, tx: Tx = prisma) =>
  tx.passwordSetupToken.findFirst({
    where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    include: { user: true },
  });

/** Marks the token used; false when another request used or expired it first. */
export const consume = async (
  id: string,
  tx: Tx = prisma
): Promise<boolean> => {
  const { count } = await tx.passwordSetupToken.updateMany({
    where: { id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return count === 1;
};

/**
 * Retires every unused token of the user, expired ones too: the partial
 * unique index allows one row per user with `used_at` null.
 */
export const invalidateForUser = (userId: string, tx: Tx = prisma) =>
  tx.passwordSetupToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
