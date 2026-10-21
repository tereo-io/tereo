import { Prisma } from "../../../prisma/generated/client/index.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export const getByProviderSubject = async (
  providerId: string,
  subject: string
) => {
  return await prisma.userIdentity.findUnique({
    where: { providerId_subject: { providerId, subject } },
  });
};

export const getForUserAtProvider = async (
  userId: string,
  providerId: string,
  tx?: Tx
) => {
  return await (tx ?? prisma).userIdentity.findUnique({
    where: { userId_providerId: { userId, providerId } },
  });
};

/** One of the user's identities; another user's is not found. */
export const get = async (userId: string, id: string) => {
  const identity = await prisma.userIdentity.findFirst({
    where: { id, userId },
  });
  if (!identity) throw new NotFoundError("Identity not found");
  return identity;
};

export const listForUser = async (userId: string) => {
  return await prisma.userIdentity.findMany({
    where: { userId },
    include: { provider: { select: { slug: true, displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
};

/** The user's identities a sign-in could use now: those at active providers. */
export const countUsableForUser = async (
  userId: string,
  except: string | null,
  tx?: Tx
) => {
  return await (tx ?? prisma).userIdentity.count({
    where: {
      userId,
      provider: { isActive: true },
      ...(except && { id: { not: except } }),
    },
  });
};

export const create = async (
  data: {
    userId: string;
    providerId: string;
    subject: string;
    email: string | null;
  },
  tx?: Tx
) => {
  return await (tx ?? prisma).userIdentity.create({ data });
};

export const touchLogin = async (id: string, email: string | null) => {
  await prisma.userIdentity.update({
    where: { id },
    data: { lastLoginAt: new Date(), email },
  });
};

/** False when the identity was already gone. */
export const deleteIdentity = async (id: string, tx?: Tx): Promise<boolean> => {
  const { count } = await (tx ?? prisma).userIdentity.deleteMany({
    where: { id },
  });
  return count === 1;
};
export { deleteIdentity as delete };

/** Issues the invite, replacing any earlier one for the same user and provider. */
export const upsertInvite = async (
  data: {
    userId: string;
    providerId: string;
    createdBy: string;
    expiresAt: Date;
  },
  tx?: Tx
) => {
  const { userId, providerId, createdBy, expiresAt } = data;
  return await (tx ?? prisma).identityInvite.upsert({
    where: { userId_providerId: { userId, providerId } },
    create: data,
    update: { createdBy, expiresAt, createdAt: new Date() },
  });
};

/** The unexpired invite for an email at a provider, with the invited user's email. */
export const findInvite = async (providerId: string, email: string) => {
  return await prisma.identityInvite.findFirst({
    where: {
      providerId,
      expiresAt: { gt: new Date() },
      user: { email: { equals: email, mode: "insensitive" } },
    },
    include: { user: { select: { email: true } } },
  });
};

export const listInvites = async (userId: string) => {
  return await prisma.identityInvite.findMany({
    where: { userId },
    include: {
      provider: { select: { id: true, slug: true, displayName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
};

export const getInvite = async (userId: string, providerId: string) => {
  return await prisma.identityInvite.findUnique({
    where: { userId_providerId: { userId, providerId } },
  });
};

/** Returns how many invites were removed (0 or 1). */
export const deleteInvite = async (
  userId: string,
  providerId: string,
  tx?: Tx
): Promise<number> => {
  const { count } = await (tx ?? prisma).identityInvite.deleteMany({
    where: { userId, providerId },
  });
  return count;
};

/** Withdraws every invite the user holds; returns how many. */
export const deleteInvitesForUser = async (
  userId: string,
  tx?: Tx
): Promise<number> => {
  const { count } = await (tx ?? prisma).identityInvite.deleteMany({
    where: { userId },
  });
  return count;
};

export const cleanupExpiredInvites = async (): Promise<number> => {
  const { count } = await prisma.identityInvite.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
};

/** People whose email is at `domain` and who hold an identity at another provider than `providerId`. */
export const usersAtDomainLinkedElsewhere = async (
  domain: string,
  providerId: string
) => {
  return await prisma.user.findMany({
    where: {
      email: { endsWith: `@${domain}` },
      userType: "human",
      identities: { some: { providerId: { not: providerId } } },
    },
    select: { id: true, email: true },
  });
};
