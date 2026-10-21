import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

interface CreateAccessTokenData {
  jti: string;
  clientId: string;
  /** The user, or for client_credentials the client's service-account user. */
  userId: string;
  organizationId?: string | null;
  authCodeId?: string | null;
  refreshTokenId?: string | null;
  scopes: string[];
  expiresAt: Date;
}

export const getByJti = async (jti: string) => {
  return await prisma.accessToken.findUnique({
    where: { jti },
    include: {
      client: { include: { service: { select: { id: true } } } },
      refreshToken: true,
    },
  });
};

export const create = async (
  data: CreateAccessTokenData,
  tx?: Prisma.TransactionClient
) => {
  await (tx ?? prisma).accessToken.create({ data });
};

/**
 * The jtis among `jtis` whose row is live: not revoked, its refresh token (if
 * any) not revoked, its user active. A deleted client or refresh token takes
 * the row with it.
 */
export const getActiveJtis = async (jtis: string[]): Promise<string[]> => {
  if (jtis.length === 0) return [];
  const rows = await prisma.accessToken.findMany({
    where: {
      jti: { in: jtis },
      revokedAt: null,
      user: { isActive: true },
      OR: [{ refreshTokenId: null }, { refreshToken: { revokedAt: null } }],
    },
    select: { jti: true },
  });
  return rows.map((t) => t.jti);
};

export const revokeByJti = async (
  jti: string,
  clientId: string
): Promise<string | null> => {
  const now = new Date();
  const token = await prisma.accessToken.findFirst({
    where: { jti, clientId, revokedAt: null, expiresAt: { gt: now } },
    select: { jti: true },
  });
  if (!token) return null;
  await prisma.accessToken.updateMany({
    where: { jti, clientId, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
  });
  return token.jti;
};

export const revokeByAuthCodeId = async (
  authCodeId: string,
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const db = tx ?? prisma;
  const now = new Date();
  const tokens = await db.accessToken.findMany({
    where: { authCodeId, revokedAt: null, expiresAt: { gt: now } },
    select: { jti: true },
  });
  if (tokens.length === 0) return [];
  const jtis = tokens.map((t) => t.jti);
  await db.accessToken.updateMany({
    where: { authCodeId, revokedAt: null },
    data: { revokedAt: now },
  });
  return jtis;
};

export const revokeByRefreshTokenIds = async (
  refreshTokenIds: string[],
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  if (refreshTokenIds.length === 0) return [];
  const db = tx ?? prisma;
  const now = new Date();
  const tokens = await db.accessToken.findMany({
    where: {
      refreshTokenId: { in: refreshTokenIds },
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { jti: true },
  });
  if (tokens.length === 0) return [];
  const jtis = tokens.map((t) => t.jti);
  await db.accessToken.updateMany({
    where: { refreshTokenId: { in: refreshTokenIds }, revokedAt: null },
    data: { revokedAt: now },
  });
  return jtis;
};

export const revokeByAuthCodeIds = async (
  authCodeIds: string[],
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  if (authCodeIds.length === 0) return [];
  const revoked = await tx.accessToken.updateManyAndReturn({
    where: { authCodeId: { in: authCodeIds }, revokedAt: null },
    data: { revokedAt: new Date() },
    select: { jti: true },
  });
  return revoked.map((t) => t.jti);
};

/**
 * Revokes the user's live access tokens that no refresh token carries (from
 * clients without the refresh_token grant), all but `exceptJti`. Returns
 * their jtis.
 */
export const revokeSessionlessByUserId = async (
  userId: string,
  exceptJti: string | null,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const now = new Date();
  const revoked = await tx.accessToken.updateManyAndReturn({
    where: {
      userId,
      refreshTokenId: null,
      revokedAt: null,
      expiresAt: { gt: now },
      ...(exceptJti && { jti: { not: exceptJti } }),
    },
    data: { revokedAt: now },
    select: { jti: true },
  });
  return revoked.map((t) => t.jti);
};

export const revokeByClientId = async (
  clientId: string,
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const db = tx ?? prisma;
  const now = new Date();
  const tokensToRevoke = await db.accessToken.findMany({
    where: { clientId, revokedAt: null, expiresAt: { gt: now } },
    select: { jti: true },
  });
  if (tokensToRevoke.length === 0) return [];
  const jtis = tokensToRevoke.map((t) => t.jti);
  await db.accessToken.updateMany({
    where: { jti: { in: jtis } },
    data: { revokedAt: now },
  });
  return jtis;
};

export const revokeByUserAndOrganization = async (
  userId: string,
  organizationId: string,
  tx?: Prisma.TransactionClient
): Promise<number> => {
  const result = await (tx ?? prisma).accessToken.updateMany({
    where: { userId, organizationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
};

export const revokeByOrganizationId = async (
  organizationId: string,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const now = new Date();
  const revoked = await tx.accessToken.updateManyAndReturn({
    where: { organizationId, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
    select: { jti: true },
  });
  return revoked.map((t) => t.jti);
};

// What `usedMfa` (utils/authorization.ts) counts as a second factor.
const MFA_AUTH_METHODS = ["otp", "recovery", "mfa"];

/**
 * Revokes the live access tokens of the people matching `users` that came
 * from a login without a second factor (a token with no login counts as
 * one), so the client's next refresh meets the 2FA step-up. Returns their
 * jtis.
 */
export const revokeWithoutMfa = async (
  users: Prisma.UserWhereInput,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const now = new Date();
  const revoked = await tx.accessToken.updateManyAndReturn({
    where: {
      revokedAt: null,
      expiresAt: { gt: now },
      user: { ...users, userType: "human" },
      OR: [
        { authCodeId: null },
        { authCode: { NOT: { authMethods: { hasSome: MFA_AUTH_METHODS } } } },
      ],
    },
    data: { revokedAt: now },
    select: { jti: true },
  });
  return revoked.map((t) => t.jti);
};

export const deleteExpiredBefore = async (cutoff: Date): Promise<number> => {
  const result = await prisma.accessToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
};
