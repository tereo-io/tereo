import { prisma } from "./prisma.js";
import {
  Prisma,
  UserLinkPurpose,
} from "../../../prisma/generated/client/index.js";

type Tx = Prisma.TransactionClient;

/** The purposes that set a password; one live link among them per user. */
export const PASSWORD_LINK_PURPOSES = ["setup", "reset"] as const;

export const create = (
  data: Prisma.UserLinkTokenUncheckedCreateInput,
  tx: Tx = prisma
) => tx.userLinkToken.create({ data });

/** The unused, unexpired token with this hash and purpose, with its user. */
export const findLiveByHash = (
  tokenHash: string,
  purposes: readonly UserLinkPurpose[],
  tx: Tx = prisma
) =>
  tx.userLinkToken.findFirst({
    where: {
      tokenHash,
      purpose: { in: [...purposes] },
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: true },
  });

/** Marks the token used; false when another request used or expired it first. */
export const consume = async (
  id: string,
  tx: Tx = prisma
): Promise<boolean> => {
  const { count } = await tx.userLinkToken.updateMany({
    where: { id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return count === 1;
};

/**
 * Retires every unused token of the user with one of the purposes, expired
 * ones too: the partial unique indexes allow one such row per user.
 */
export const invalidateForUser = (
  userId: string,
  purposes: readonly UserLinkPurpose[],
  tx: Tx = prisma
) =>
  tx.userLinkToken.updateMany({
    where: { userId, purpose: { in: [...purposes] }, usedAt: null },
    data: { usedAt: new Date() },
  });

/**
 * Deletes tokens expired or used (retired included) before `cutoff`: kept
 * until then so a late use still meets a row that explains its 404.
 */
export const deleteSpentBefore = async (
  cutoff: Date,
  tx: Tx = prisma
): Promise<number> => {
  const { count } = await tx.userLinkToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }],
    },
  });
  return count;
};
