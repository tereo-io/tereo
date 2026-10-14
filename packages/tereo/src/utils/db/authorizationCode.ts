import { hashAuthorizationCode } from "../crypto.js";
import type { Prisma } from "./prisma.js";
import { prisma } from "./prisma.js";

interface AuthorizationCode {
  id: string;
  createdAt: Date;
  codeHash: string;
  clientId: string;
  userId: string;
  organizationId: string | null;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  nonce: string | null;
  authTime: Date;
  maxAge: number | null;
  acrValues: string | null;
  authMethods: string[];
  userSessionId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  user: {
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    id: string;
    email: string;
    passwordHash: string | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    photoObjectId: string | null;
  };
}

interface CreateAuthCodeData {
  codeHash: string;
  clientId: string;
  userId: string;
  organizationId?: string | null;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  nonce?: string | null;
  authTime: Date;
  maxAge?: number | null;
  acrValues?: string | null;
  authMethods?: string[];
  userSessionId?: string | null;
  expiresAt: Date;
}

export const get = async (code: string): Promise<AuthorizationCode | null> => {
  return await prisma.authorizationCode.findUnique({
    where: { codeHash: hashAuthorizationCode(code) },
    include: { user: true },
  });
};

export const create = async (
  data: CreateAuthCodeData,
  tx?: Prisma.TransactionClient
) => {
  await (tx ?? prisma).authorizationCode.create({ data });
};

/** What a refresh's ID token repeats from the login its family began with. */
export const getLoginContextById = async (id: string) =>
  prisma.authorizationCode.findUnique({
    where: { id },
    select: { authTime: true, authMethods: true, userSessionId: true },
  });

/** The token families (code ids) issued under these SSO sessions. */
export const getIdsByUserSessionIds = async (
  userSessionIds: string[],
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  if (userSessionIds.length === 0) return [];
  const codes = await (tx ?? prisma).authorizationCode.findMany({
    where: { userSessionId: { in: userSessionIds } },
    select: { id: true },
  });
  return codes.map((c) => c.id);
};

/**
 * Marks the code used; false when it already was, or when the SSO session it
 * was issued under has ended (ending one sets `user_session_id` to null), so
 * a code obtained before a sign-out cannot start a session after it.
 */
export const markUsed = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const { count } = await (tx ?? prisma).authorizationCode.updateMany({
    where: { id, usedAt: null, userSessionId: { not: null } },
    data: { usedAt: new Date() },
  });
  return count === 1;
};

// A code identifies its token family and cascades to it, so it goes only once
// no token of the family is left.
export const deleteExpiredBefore = async (cutoff: Date): Promise<number> => {
  const result = await prisma.authorizationCode.deleteMany({
    where: {
      expiresAt: { lt: cutoff },
      accessTokens: { none: {} },
      refreshTokens: { none: {} },
    },
  });
  return result.count;
};
