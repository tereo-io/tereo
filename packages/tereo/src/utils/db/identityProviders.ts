import { Prisma } from "../../../prisma/generated/client/index.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export const list = async (opts: { activeOnly?: boolean } = {}) => {
  return await prisma.identityProvider.findMany({
    where: opts.activeOnly ? { isActive: true } : undefined,
    orderBy: { displayName: "asc" },
  });
};

export const get = async (id: string) => {
  const provider = await prisma.identityProvider.findUnique({ where: { id } });
  if (!provider) throw new NotFoundError("Identity provider not found");
  return provider;
};

/**
 * Row-locks the provider for the rest of `tx` and returns it as committed. The
 * lock serializes writes whose checks read state another write changes (an
 * SSO-only domain against deactivation, countsAsMfa against an issuer change).
 */
export const lockForUpdate = async (id: string, tx: Tx) => {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "auth"."identity_providers" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  if (locked.length === 0) {
    throw new NotFoundError("Identity provider not found");
  }
  return await tx.identityProvider.findUniqueOrThrow({ where: { id } });
};

export const getBySlug = async (slug: string) => {
  return await prisma.identityProvider.findUnique({ where: { slug } });
};

export const create = async (
  data: Prisma.IdentityProviderUncheckedCreateInput,
  tx?: Tx
) => {
  return await (tx ?? prisma).identityProvider.create({ data });
};

export const update = async (
  id: string,
  data: Prisma.IdentityProviderUncheckedUpdateInput,
  tx?: Tx
) => {
  return await (tx ?? prisma).identityProvider.update({ where: { id }, data });
};

export const setActive = async (id: string, isActive: boolean, tx?: Tx) => {
  return await (tx ?? prisma).identityProvider.update({
    where: { id },
    data: { isActive },
  });
};

export const hasIdentities = async (id: string): Promise<boolean> => {
  const row = await prisma.userIdentity.findFirst({
    where: { providerId: id },
    select: { id: true },
  });
  return row !== null;
};

/** Whether an unexpired identity invite names the provider. */
export const hasPendingInvites = async (id: string): Promise<boolean> => {
  const row = await prisma.identityInvite.findFirst({
    where: { providerId: id, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return row !== null;
};

export const hasSsoOnlyDomain = async (
  id: string,
  tx?: Tx
): Promise<boolean> => {
  const row = await (tx ?? prisma).identityProviderDomain.findFirst({
    where: { providerId: id, ssoOnly: true },
    select: { id: true },
  });
  return row !== null;
};

export const listDomains = async (providerId: string) => {
  return await prisma.identityProviderDomain.findMany({
    where: { providerId },
    include: {
      roles: { select: { role: true } },
      organization: true,
    },
    orderBy: { domain: "asc" },
  });
};

export const getDomain = async (
  providerId: string,
  domainId: string,
  tx?: Tx
) => {
  const domain = await (tx ?? prisma).identityProviderDomain.findFirst({
    where: { id: domainId, providerId },
    include: {
      roles: { select: { role: true } },
      organization: true,
    },
  });
  if (!domain) throw new NotFoundError("Domain not found");
  return domain;
};

/** The domain, with its provider and organization, for an email's domain part; null if none. */
export const findDomain = async (domain: string, tx?: Tx) => {
  return await (tx ?? prisma).identityProviderDomain.findUnique({
    where: { domain },
    include: { provider: true, organization: true },
  });
};

export const createDomain = async (
  data: Prisma.IdentityProviderDomainUncheckedCreateInput,
  tx?: Tx
) => {
  return await (tx ?? prisma).identityProviderDomain.create({ data });
};

export const updateDomain = async (
  id: string,
  data: Prisma.IdentityProviderDomainUncheckedUpdateInput,
  tx?: Tx
) => {
  return await (tx ?? prisma).identityProviderDomain.update({
    where: { id },
    data,
  });
};

export const deleteDomain = async (id: string, tx?: Tx) => {
  await (tx ?? prisma).identityProviderDomain.delete({ where: { id } });
};

/** Replaces the domain's default roles with `roleIds`. */
export const setDomainRoles = async (
  domainId: string,
  roleIds: string[],
  tx?: Tx
) => {
  const run = async (client: Tx) => {
    await client.identityProviderDomainRole.deleteMany({ where: { domainId } });
    await client.identityProviderDomainRole.createMany({
      data: [...new Set(roleIds)].map((roleId) => ({ domainId, roleId })),
    });
  };
  if (tx) return await run(tx);
  await prisma.$transaction(run);
};
