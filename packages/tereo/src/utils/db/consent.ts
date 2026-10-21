import { Prisma } from "../../../prisma/generated/client/index.js";
import { NotFoundError } from "../errors.js";
import { hashFlowToken } from "../crypto.js";
import { prisma } from "./prisma.js";

export interface ConsentSessionData {
  id: string;
  tokenHash: string;
  userId: string;
  clientId: string;
  organizationId: string | null;
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
  provider: string | null;
  userSessionId: string | null;
  expiresAt: Date;
}

export interface ConsentDetails {
  sessionToken: string;
  clientName: string;
  clientId: string;
  scopes: Array<{
    name: string;
    description: string | null;
  }>;
  user: {
    email: string;
    name: string | null;
  };
}

export const createConsentSession = async (
  {
    sessionToken,
    ...data
  }: {
    sessionToken: string;
    userId: string;
    clientId: string;
    organizationId?: string | null;
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
    provider?: string | null;
    userSessionId?: string | null;
    expiresAt: Date;
  },
  tx?: Prisma.TransactionClient
): Promise<ConsentSessionData> => {
  return await (tx ?? prisma).consentSession.create({
    data: { ...data, tokenHash: hashFlowToken(sessionToken) },
  });
};

export const getConsentSession = async (
  sessionToken: string
): Promise<ConsentSessionData | null> => {
  return await prisma.consentSession.findUnique({
    where: { tokenHash: hashFlowToken(sessionToken) },
  });
};

export const getConsentDetails = async (
  sessionToken: string
): Promise<ConsentDetails> => {
  const session = await prisma.consentSession.findUnique({
    where: { tokenHash: hashFlowToken(sessionToken) },
    include: {
      client: { select: { clientId: true, name: true } },
      user: { select: { email: true, name: true } },
    },
  });

  if (!session) {
    throw new NotFoundError("Consent session not found or expired");
  }

  if (session.expiresAt < new Date()) {
    await prisma.consentSession.delete({ where: { id: session.id } });
    throw new NotFoundError("Consent session expired");
  }

  const scopeRecords = await prisma.scope.findMany({
    where: { name: { in: session.scopes } },
    select: { name: true, description: true },
  });

  const scopeMap = new Map(scopeRecords.map((s) => [s.name, s.description]));
  const scopes = session.scopes.map((name: string) => ({
    name,
    description: scopeMap.get(name) || null,
  }));

  return {
    sessionToken,
    clientName: session.client.name,
    clientId: session.client.clientId,
    scopes,
    user: { email: session.user.email, name: session.user.name },
  };
};

/** Deletes the session; false when another request already consumed it. */
export const consumeConsentSession = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const { count } = await (tx ?? prisma).consentSession.deleteMany({
    where: { id },
  });
  return count === 1;
};

export const deleteConsentSession = async (id: string): Promise<void> => {
  await prisma.consentSession.delete({ where: { id } });
};

export const cleanupExpiredConsentSessions = async (): Promise<number> => {
  const result = await prisma.consentSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};
