import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

export interface PasswordChangeGrantData {
  id: string;
  tokenHash: string;
  cookieSecretHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
  maxAge: number | null;
  acrValues: string | null;
  prompt: string | null;
  firstFactor: string[];
  expiresAt: Date;
}

export const create = async (
  data: Omit<PasswordChangeGrantData, "id" | "firstFactor"> & {
    firstFactor?: string[];
  },
  tx?: Prisma.TransactionClient
): Promise<PasswordChangeGrantData> => {
  return await (tx ?? prisma).passwordChangeGrant.create({ data });
};

export const get = async (
  tokenHash: string
): Promise<PasswordChangeGrantData | null> => {
  return await prisma.passwordChangeGrant.findUnique({ where: { tokenHash } });
};

// Returns false when another request already consumed the grant.
export const consume = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const result = await (tx ?? prisma).passwordChangeGrant.deleteMany({
    where: { id },
  });
  return result.count === 1;
};

/** Deletes every grant of the user, live or not. */
export const deleteForUser = async (
  userId: string,
  tx: Prisma.TransactionClient
): Promise<number> => {
  const result = await tx.passwordChangeGrant.deleteMany({
    where: { userId },
  });
  return result.count;
};

export const cleanupExpired = async (): Promise<number> => {
  const result = await prisma.passwordChangeGrant.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};
