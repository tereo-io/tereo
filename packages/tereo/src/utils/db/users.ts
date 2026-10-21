import { UpdateUserInput } from "../../routes/v1/admin/users/user/schemas.js";
import { CreateUserInput } from "../../routes/v1/admin/users/schemas.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { hashPassword, needsRehash } from "../crypto.js";
import { normalizeEmail } from "../email.js";
import { prisma } from "./prisma.js";

/**
 * Issuing tokens holds the user's row shared and ending sessions holds it
 * exclusively, each for its whole transaction: an end waits for an issue in
 * flight and then sees (and revokes) what it created, and an issue that
 * waited finds its refresh token or code already spent.
 */
export const lockForTokenIssue = async (
  userId: string,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.$queryRaw`SELECT 1 FROM "auth"."users" WHERE id = ${userId}::uuid FOR SHARE`;
};

/**
 * The users named, those owning these SSO sessions or token families, and
 * the members of these organizations with everyone holding a live refresh
 * token or SSO session there.
 */
export const lockForSessionEnd = async (
  tx: Prisma.TransactionClient,
  {
    userIds = [],
    userSessionIds = [],
    authCodeIds = [],
    organizationIds = [],
  }: {
    userIds?: string[];
    userSessionIds?: string[];
    authCodeIds?: string[];
    organizationIds?: string[];
  }
): Promise<void> => {
  await tx.$queryRaw`
    SELECT 1 FROM "auth"."users"
    WHERE id = ANY(${userIds}::uuid[])
      OR id IN (SELECT user_id FROM "auth"."user_sessions" WHERE id = ANY(${userSessionIds}::uuid[]))
      OR id IN (SELECT user_id FROM "auth"."authorization_codes" WHERE id = ANY(${authCodeIds}::uuid[]))
      OR id IN (SELECT user_id FROM "auth"."organization_members" WHERE organization_id = ANY(${organizationIds}::uuid[]))
      OR id IN (SELECT user_id FROM "auth"."refresh_tokens" WHERE organization_id = ANY(${organizationIds}::uuid[]) AND revoked_at IS NULL)
      OR id IN (SELECT user_id FROM "auth"."user_sessions" WHERE organization_id = ANY(${organizationIds}::uuid[]))
    ORDER BY id
    FOR UPDATE`;
};

/** Serializes changes to the user's ways of signing in. */
export const lockForSignInChange = async (
  userId: string,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.$queryRaw`SELECT 1 FROM "auth"."users" WHERE id = ${userId}::uuid FOR UPDATE`;
};

/**
 * Serializes admin changes to the user's roles (global or in an organization)
 * with admin resets of their credentials, so a check that the caller holds
 * what the target holds sees the target as of the write. Taken first in the
 * transaction: before lockOrgOwners, assertAdminRemains and any user row lock.
 */
export const lockAuthority = async (
  userId: string,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core:user-authority:${userId}`}, 0))`;
};

export const get = async (id: string, tx?: Prisma.TransactionClient) => {
  const db = tx ?? prisma;
  const res = await db.user.findUnique({ where: { id } });
  if (!res) throw new NotFoundError("User not found");
  return res;
};

/** A user named in a request body: one that is missing is a 400, not a 404. */
export const getFromBody = async (
  id: string,
  tx?: Prisma.TransactionClient
) => {
  const res = await (tx ?? prisma).user.findUnique({ where: { id } });
  if (!res) throw new BadRequestError("unknown_user", `Unknown user: ${id}`);
  return res;
};

export const getAll = async () => {
  return await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
};

interface GetPaginatedOptions {
  /** Over-fetch happens inside the helper — pass the user's requested page size. */
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
}

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where } = options;

  const rows = await prisma.user.findMany({
    take: take + 1,
    orderBy: orderBy as Record<string, "asc" | "desc">[],
    where: where as Record<string, unknown>,
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};

export const create = async (
  data: CreateUserInput & { id?: string },
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  const passwordHash =
    data.password === undefined ? null : await hashPassword(data.password);
  return await db.user.create({
    data: {
      // Explicit id for deterministic service-account users (so file-seed et al.
      // can grant to a recomputable id without reading it back from auth).
      ...(data.id ? { id: data.id } : {}),
      email: data.email,
      passwordHash,
      name: data.name,
      userType: data.userType,
    },
  });
};

/** A person who signs in only through an identity provider. */
export const createWithoutPassword = async (
  data: {
    email: string;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
  },
  tx?: Prisma.TransactionClient
) => {
  return await (tx ?? prisma).user.create({
    data: { ...data, email: normalizeEmail(data.email), passwordHash: null },
  });
};

export const update = async (
  id: string,
  data: UpdateUserInput,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  const updateData: {
    email?: string;
    passwordHash?: string;
    name?: string;
    isActive?: boolean;
  } = {};

  if (data.email) updateData.email = data.email;
  if (data.name !== undefined) updateData.name = data.name;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.password) {
    updateData.passwordHash = await hashPassword(data.password);
  }

  return await db.user.update({ where: { id }, data: updateData });
};

/**
 * Stores `password`, just verified against `currentHash`, at the current
 * scrypt parameters when that hash is on older ones. Returns the hash the
 * user now has: the new one, or `currentHash` when nothing was due or the
 * password changed since it was read (the update is conditional on it, so a
 * concurrent change is never overwritten).
 */
export const upgradePasswordHash = async (
  id: string,
  currentHash: string,
  password: string
): Promise<string> => {
  if (!needsRehash(currentHash)) return currentHash;
  const passwordHash = await hashPassword(password);
  const { count } = await prisma.user.updateMany({
    where: { id, passwordHash: currentHash },
    data: { passwordHash },
  });
  return count === 1 ? passwordHash : currentHash;
};

export const clearPassword = async (
  id: string,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.user.update({ where: { id }, data: { passwordHash: null } });
};

export const getByEmail = async (
  email: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  return await db.user.findUnique({ where: { email: normalizeEmail(email) } });
};

export const getByOAuthClientId = async (oauthClientId: string) => {
  return await prisma.user.findUnique({ where: { oauthClientId } });
};

export const getProfilePhotoId = async (id: string): Promise<string | null> => {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { photoObjectId: true },
  });
  return user?.photoObjectId ?? null;
};
