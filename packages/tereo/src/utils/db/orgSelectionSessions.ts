import { Prisma } from "../../../prisma/generated/client/index.js";
import { hashFlowToken } from "../crypto.js";
import { prisma } from "./prisma.js";

export interface OrgSelectionSessionData {
  id: string;
  tokenHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
  authTime: Date;
  maxAge: number | null;
  acrValues: string | null;
  prompt: string | null;
  authMethods: string[];
  expiresAt: Date;
}

export const create = async (
  {
    sessionToken,
    ...data
  }: {
    sessionToken: string;
    userId: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string | null;
    codeChallenge: string;
    codeChallengeMethod: string;
    nonce: string | null;
    authTime: Date;
    maxAge?: number | null;
    acrValues?: string | null;
    prompt?: string | null;
    authMethods?: string[];
    expiresAt: Date;
  },
  tx?: Prisma.TransactionClient
): Promise<OrgSelectionSessionData> => {
  return await (tx ?? prisma).orgSelectionSession.create({
    data: { ...data, tokenHash: hashFlowToken(sessionToken) },
  });
};

export const get = async (
  sessionToken: string
): Promise<OrgSelectionSessionData | null> => {
  return await prisma.orgSelectionSession.findUnique({
    where: { tokenHash: hashFlowToken(sessionToken) },
  });
};

/** Deletes the session; false when another request already consumed it. */
export const consume = async (id: string): Promise<boolean> => {
  const { count } = await prisma.orgSelectionSession.deleteMany({
    where: { id },
  });
  return count === 1;
};

export const remove = async (id: string): Promise<void> => {
  await prisma.orgSelectionSession.delete({ where: { id } });
};

export const cleanupExpired = async (): Promise<number> => {
  const result = await prisma.orgSelectionSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};
