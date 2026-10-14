import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export const createSession = async (
  data: Prisma.UpstreamAuthSessionUncheckedCreateInput
) => {
  return await prisma.upstreamAuthSession.create({ data });
};

/**
 * Takes the unexpired session for `stateHash` at `providerId`, deleting it.
 * The delete is conditional on the row, so of two concurrent callbacks only
 * one gets it; the other, and a callback at another provider, get null.
 */
export const consumeSession = async (stateHash: string, providerId: string) => {
  return await prisma.$transaction(async (tx) => {
    const session = await tx.upstreamAuthSession.findFirst({
      where: { stateHash, providerId, expiresAt: { gt: new Date() } },
    });
    if (!session) return null;
    const { count } = await tx.upstreamAuthSession.deleteMany({
      where: { id: session.id },
    });
    return count === 1 ? session : null;
  });
};

export const cleanupExpiredSessions = async (): Promise<number> => {
  const { count } = await prisma.upstreamAuthSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
};

export const createLinkGrant = async (
  data: Prisma.IdentityLinkGrantUncheckedCreateInput,
  tx?: Tx
) => {
  return await (tx ?? prisma).identityLinkGrant.create({ data });
};

export const getLinkGrant = async (tokenHash: string) => {
  return await prisma.identityLinkGrant.findFirst({
    where: { tokenHash, expiresAt: { gt: new Date() } },
  });
};

/** Deletes the grant; false when another request already consumed it, or it expired. */
export const consumeLinkGrant = async (
  id: string,
  tx?: Tx
): Promise<boolean> => {
  const { count } = await (tx ?? prisma).identityLinkGrant.deleteMany({
    where: { id, expiresAt: { gt: new Date() } },
  });
  return count === 1;
};

export const cleanupExpiredLinkGrants = async (): Promise<number> => {
  const { count } = await prisma.identityLinkGrant.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
};
