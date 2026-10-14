import { Prisma } from "../../../prisma/generated/client/index.js";
import { hashFlowToken } from "../crypto.js";
import { prisma } from "./prisma.js";

// token_prefix is a NOT NULL column that nothing reads: tokens are looked up
// by their SHA-256.
const TOKEN_PREFIX_LENGTH = 16;

interface CreateRefreshTokenData {
  token: string;
  clientId: string;
  userId: string;
  organizationId?: string | null;
  authCodeId?: string | null;
  scopes: string[];
  expiresAt: Date;
}

export const get = async (token: string) => {
  return prisma.refreshToken.findUnique({
    where: { tokenHash: hashFlowToken(token) },
    include: { client: true, user: true },
  });
};

export const create = async (
  data: CreateRefreshTokenData,
  tx?: Prisma.TransactionClient
) => {
  const tokenHash = hashFlowToken(data.token);
  const tokenPrefix = data.token.substring(0, TOKEN_PREFIX_LENGTH);

  const refreshToken = await (tx ?? prisma).refreshToken.create({
    data: {
      tokenHash,
      tokenPrefix,
      clientId: data.clientId,
      userId: data.userId,
      organizationId: data.organizationId ?? null,
      authCodeId: data.authCodeId,
      scopes: data.scopes,
      expiresAt: data.expiresAt,
    },
  });

  return refreshToken.id;
};

/**
 * Spends the token on a refresh: revokes it and marks it rotated, which
 * tells a later replay apart from a token ended by logout. False when it
 * already was revoked.
 */
export const rotateIfActive = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> => {
  const now = new Date();
  const { count } = await (tx ?? prisma).refreshToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: now, rotatedAt: now },
  });
  return count === 1;
};

/**
 * Whether a token of the family was spent on a refresh after `since`: the
 * successor of a token rotated at `since` (or a later one) has been used.
 */
export const familyRotatedSince = async (
  authCodeId: string,
  since: Date
): Promise<boolean> =>
  (await prisma.refreshToken.count({
    where: { authCodeId, rotatedAt: { gt: since } },
  })) > 0;

export const revokeByAuthCodeId = async (
  authCodeId: string,
  tx?: Prisma.TransactionClient
) => {
  await (tx ?? prisma).refreshToken.updateMany({
    where: { authCodeId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

/** Revokes every live token of these families; returns the revoked rows. */
export const revokeByAuthCodeIds = async (
  authCodeIds: string[],
  tx?: Prisma.TransactionClient
): Promise<{ id: string; userId: string }[]> => {
  if (authCodeIds.length === 0) return [];
  const db = tx ?? prisma;
  const tokens = await db.refreshToken.findMany({
    where: { authCodeId: { in: authCodeIds }, revokedAt: null },
    select: { id: true, userId: true },
  });
  if (tokens.length === 0) return [];
  await db.refreshToken.updateMany({
    where: { id: { in: tokens.map((t) => t.id) } },
    data: { revokedAt: new Date() },
  });
  return tokens;
};

export const getActiveByUserId = async (
  userId: string,
  tx?: Prisma.TransactionClient
) => {
  return (tx ?? prisma).refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { client: true },
    orderBy: { createdAt: "desc" },
  });
};

export const getActiveByUserAndOrganization = async (
  userId: string,
  organizationId: string,
  tx?: Prisma.TransactionClient
) => {
  return (tx ?? prisma).refreshToken.findMany({
    where: { userId, organizationId, revokedAt: null },
    select: { id: true, authCodeId: true },
  });
};

/** A live session (refresh token) of this user, or null. */
export const getActiveForUser = async (id: string, userId: string) => {
  return prisma.refreshToken.findFirst({
    where: { id, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, clientId: true },
  });
};

export const revokeByIds = async (
  ids: string[],
  tx?: Prisma.TransactionClient
) => {
  if (ids.length === 0) return 0;
  const result = await (tx ?? prisma).refreshToken.updateMany({
    where: { id: { in: ids }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
};

/**
 * Revokes every live refresh token issued under the organization, by
 * predicate: a token rotated in after any earlier read is caught too.
 */
export const revokeByOrganizationId = async (
  organizationId: string,
  tx: Prisma.TransactionClient
): Promise<{ id: string; userId: string }[]> => {
  return tx.refreshToken.updateManyAndReturn({
    where: { organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
    select: { id: true, userId: true },
  });
};

export const revokeByClientId = async (clientId: string) => {
  await prisma.refreshToken.updateMany({
    where: { clientId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

export const getById = async (id: string) => {
  return prisma.refreshToken.findUnique({ where: { id } });
};

// Revoked tokens are kept until they expire: replaying one is how reuse
// detection finds the family to revoke (utils/auth.ts).
export const deleteExpiredBefore = async (cutoff: Date): Promise<number> => {
  const result = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
};
