import { Prisma } from "../../../prisma/generated/client/index.js";
import { hashFlowToken } from "../crypto.js";
import { prisma } from "./prisma.js";
import env from "../../env.js";

export interface UserSessionData {
  id: string;
  tokenHash: string;
  userId: string;
  organizationId: string | null;
  authTime: Date;
  authMethods: string[];
  acrValue: string | null;
  expiresAt: Date;
  lastUsedAt: Date;
  createdAt: Date;
}

interface UserSessionInput {
  /** The raw token the cookie carries; only its hash is stored. */
  sessionToken: string;
  userId: string;
  organizationId?: string | null;
  authTime: Date;
  authMethods: string[];
  acrValue?: string | null;
  expiresAt: Date;
}

// Every write is a code being issued under the session: its use.
const toRow = ({ sessionToken, ...data }: UserSessionInput) => ({
  ...data,
  tokenHash: hashFlowToken(sessionToken),
  lastUsedAt: new Date(),
});

const idleCutoff = () =>
  new Date(Date.now() - env.USER_SESSION_IDLE_TTL * 1000);

export interface SessionLookup {
  /**
   * Find a session idle past USER_SESSION_IDLE_TTL too: for a logout, which
   * must still reach the token families issued under it, and for a password
   * login, which takes the browser's row over. Every other lookup treats such
   * a session as gone; the row stays until its absolute expiry.
   */
  includeIdle?: boolean;
}

const notIdle = ({ includeIdle }: SessionLookup) =>
  includeIdle ? {} : { lastUsedAt: { gt: idleCutoff() } };

export const createUserSession = async (
  data: UserSessionInput,
  tx?: Prisma.TransactionClient
): Promise<UserSessionData> => {
  return await (tx ?? prisma).userSession.create({ data: toRow(data) });
};

export const updateUserSession = async (
  id: string,
  data: UserSessionInput,
  tx?: Prisma.TransactionClient
): Promise<UserSessionData> => {
  return await (tx ?? prisma).userSession.update({
    where: { id },
    data: toRow(data),
  });
};

export const getUserSessionById = async (
  id: string,
  tx?: Prisma.TransactionClient,
  lookup: SessionLookup = {}
): Promise<UserSessionData | null> => {
  return await (tx ?? prisma).userSession.findUnique({
    where: { id, ...notIdle(lookup) },
  });
};

/** The SSO session the refresh token's family was issued under, if any. */
export const getIdByRefreshTokenId = async (
  refreshTokenId: string
): Promise<string | null> => {
  const token = await prisma.refreshToken.findUnique({
    where: { id: refreshTokenId },
    select: { authCode: { select: { userSessionId: true } } },
  });
  return token?.authCode?.userSessionId ?? null;
};

export const getUserSessionByToken = async (
  sessionToken: string,
  tx?: Prisma.TransactionClient,
  lookup: SessionLookup = {}
): Promise<UserSessionData | null> => {
  return await (tx ?? prisma).userSession.findUnique({
    where: { tokenHash: hashFlowToken(sessionToken), ...notIdle(lookup) },
  });
};

export const getIdsByUserAndOrganization = async (
  userId: string,
  organizationId: string,
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const sessions = await (tx ?? prisma).userSession.findMany({
    where: { userId, organizationId },
    select: { id: true },
  });
  return sessions.map((s) => s.id);
};

const deleteWhere = async (
  where: Prisma.UserSessionWhereInput,
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  const db = tx ?? prisma;
  const rows = await db.userSession.findMany({ where, select: { id: true } });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await db.userSession.deleteMany({ where: { id: { in: ids } } });
  return ids;
};

/**
 * Ends the user's SSO sessions, all but `exceptId` when it is given. Returns
 * the ids ended.
 */
export const deleteUserSessionsByUserId = async (
  userId: string,
  exceptId?: string | null,
  tx?: Prisma.TransactionClient
): Promise<string[]> =>
  deleteWhere({ userId, ...(exceptId && { id: { not: exceptId } }) }, tx);

/** Ends the given SSO sessions; returns the ids that existed. */
export const deleteUserSessionsByIds = async (
  ids: string[],
  tx?: Prisma.TransactionClient
): Promise<string[]> => {
  if (ids.length === 0) return [];
  return deleteWhere({ id: { in: ids } }, tx);
};

export const deleteByOrganizationId = async (
  organizationId: string,
  tx: Prisma.TransactionClient
): Promise<number> => {
  const result = await tx.userSession.deleteMany({ where: { organizationId } });
  return result.count;
};

export const cleanupExpiredUserSessions = async (): Promise<number> => {
  const result = await prisma.userSession.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};
