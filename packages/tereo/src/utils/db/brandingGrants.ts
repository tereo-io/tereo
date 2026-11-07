import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

export const listActive = async (clientUuid: string) => {
  return await prisma.brandingGrant.findMany({
    where: { clientId: clientUuid, revokedAt: null },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { grantedAt: "asc" },
  });
};

export const getActive = async (
  clientUuid: string,
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  return await (tx ?? prisma).brandingGrant.findFirst({
    where: { clientId: clientUuid, userId, revokedAt: null },
  });
};

export const create = async (
  data: { clientUuid: string; userId: string; grantedBy: string },
  tx: Prisma.TransactionClient
) => {
  return await tx.brandingGrant.create({
    data: {
      clientId: data.clientUuid,
      userId: data.userId,
      grantedBy: data.grantedBy,
    },
  });
};

export const revoke = async (
  clientUuid: string,
  userId: string,
  revokedBy: string,
  tx: Prisma.TransactionClient
) => {
  const { count } = await tx.brandingGrant.updateMany({
    where: { clientId: clientUuid, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy },
  });
  return count > 0;
};

/** The clients the user holds an active grant on. */
export const clientUuidsForUser = async (userId: string) => {
  const rows = await prisma.brandingGrant.findMany({
    where: { userId, revokedAt: null },
    select: { clientId: true },
  });
  return rows.map((r) => r.clientId);
};
