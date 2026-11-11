import type { ScimUser as ScimUserLink } from "../../../prisma/generated/client/index.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import type { ScimFilter } from "../scim/filter.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export type { ScimUserLink };

export const getConnectionByProvider = async (providerId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimConnection.findUnique({
    where: { providerId },
  });
};

export const getConnection = async (id: string, tx?: Tx) => {
  return await (tx ?? prisma).scimConnection.findUniqueOrThrow({
    where: { id },
  });
};

/** Row-locks the connection for the rest of `tx`; serializes token minting. */
export const lockConnection = async (id: string, tx: Tx) => {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "auth"."scim_connections" WHERE "id" = ${id}::uuid FOR UPDATE
  `;
  if (locked.length === 0) throw new NotFoundError("SCIM connection not found");
  return await tx.scimConnection.findUniqueOrThrow({ where: { id } });
};

export const createConnection = async (
  input: { providerId: string; createdBy: string },
  tx: Tx
) => {
  return await tx.scimConnection.create({ data: input });
};

export const setConnectionActive = async (
  id: string,
  isActive: boolean,
  tx: Tx
) => {
  return await tx.scimConnection.update({ where: { id }, data: { isActive } });
};

export const deleteConnection = async (id: string, tx: Tx) => {
  await tx.scimConnection.delete({ where: { id } });
};

/** Stamps `last_used_at` on the token and connection, each at most once a minute. */
export const touchConnection = async (id: string, tokenId: string) => {
  await prisma.$executeRaw`
    UPDATE "auth"."scim_connections" SET "last_used_at" = now()
    WHERE "id" = ${id}::uuid
      AND ("last_used_at" IS NULL OR "last_used_at" < now() - interval '1 minute')
  `;
  await prisma.$executeRaw`
    UPDATE "auth"."scim_tokens" SET "last_used_at" = now()
    WHERE "id" = ${tokenId}::uuid
      AND ("last_used_at" IS NULL OR "last_used_at" < now() - interval '1 minute')
  `;
};

export const listTokens = async (connectionId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimToken.findMany({
    where: { connectionId },
    orderBy: { createdAt: "asc" },
  });
};

export const createToken = async (
  input: { connectionId: string; hash: string; createdBy: string },
  tx: Tx
) => {
  return await tx.scimToken.create({ data: input });
};

/** Revokes an unrevoked token of the connection; null when there is none. */
export const revokeToken = async (
  connectionId: string,
  tokenId: string,
  tx: Tx
) => {
  const result = await tx.scimToken.updateMany({
    where: { id: tokenId, connectionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) return null;
  return await tx.scimToken.findUniqueOrThrow({ where: { id: tokenId } });
};

export const findLiveToken = async (hash: string) => {
  return await prisma.scimToken.findFirst({
    where: { hash, revokedAt: null },
    include: { connection: { include: { provider: true } } },
  });
};

export const getLinkByUser = async (userId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimUser.findUnique({ where: { userId } });
};

/** Includes links whose SCIM resource was deleted. */
export const getLink = async (
  connectionId: string,
  userId: string,
  tx?: Tx
) => {
  return await (tx ?? prisma).scimUser.findFirst({
    where: { connectionId, userId },
  });
};

export const createLink = async (
  input: {
    connectionId: string;
    userId: string;
    externalId: string | null;
    userName: string;
    idpActive: boolean;
    adminHold: boolean;
  },
  tx: Tx
) => {
  return await tx.scimUser.create({ data: input });
};

export const updateLink = async (
  id: string,
  data: Partial<
    Pick<
      ScimUserLink,
      "externalId" | "userName" | "idpActive" | "adminHold" | "deletedAt"
    >
  >,
  tx: Tx
) => {
  return await tx.scimUser.update({ where: { id }, data });
};

export const deleteLink = async (id: string, tx: Tx) => {
  await tx.scimUser.delete({ where: { id } });
};

/** Deleted links are counted. */
export const countLinks = async (connectionId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimUser.count({ where: { connectionId } });
};

/**
 * Links of the connection matching an external id, or an email as a user name
 * (case-insensitively); the caller decides which are claimable.
 */
export const findClaimable = async (
  connectionId: string,
  by: { externalId: string } | { email: string },
  tx?: Tx
) => {
  return await (tx ?? prisma).scimUser.findMany({
    where:
      "externalId" in by
        ? { connectionId, externalId: by.externalId }
        : {
            connectionId,
            userName: { equals: by.email, mode: "insensitive" },
          },
  });
};

interface VisibilityScope {
  connectionId: string;
  providerId: string;
}

/** Domains are stored as typed; email addresses are stored lower case. */
export const listProviderDomains = async (providerId: string, tx?: Tx) => {
  const rows = await (tx ?? prisma).identityProviderDomain.findMany({
    where: { providerId },
    select: { domain: true },
  });
  return rows.map((r) => r.domain.toLowerCase());
};

const managed = (connectionId: string) =>
  ({ scimLink: { is: { connectionId, deletedAt: null } } }) as const;

// A link with deleted_at set, in any connection, makes the user invisible as
// unmanaged: only a user with no link at all is claimable by domain.
const unmanagedInDomains = (domains: string[]): Prisma.UserWhereInput => ({
  scimLink: { is: null },
  OR: domains.map((d) => ({
    email: { endsWith: `@${d}`, mode: "insensitive" as const },
  })),
});

const visibleWhere = (
  scope: VisibilityScope,
  domains: string[]
): Prisma.UserWhereInput => ({
  userType: "human",
  id: { not: SYSTEM_USER_ID },
  OR: [managed(scope.connectionId), unmanagedInDomains(domains)],
});

const clauseWhere = (
  connectionId: string,
  clause: ScimFilter[number]
): Prisma.UserWhereInput => {
  const insensitive = { equals: clause.value, mode: "insensitive" as const };
  switch (clause.attr) {
    case "email":
      return { email: insensitive };
    case "externalId":
      return {
        scimLink: {
          is: { connectionId, deletedAt: null, externalId: clause.value },
        },
      };
    case "userName":
      return {
        OR: [
          {
            scimLink: {
              is: { connectionId, deletedAt: null, userName: insensitive },
            },
          },
          { scimLink: { is: null }, email: insensitive },
        ],
      };
  }
};

export const findVisibleUser = async (
  scope: VisibilityScope,
  userId: string,
  tx?: Tx
) => {
  const domains = await listProviderDomains(scope.providerId, tx);
  return await (tx ?? prisma).user.findFirst({
    where: { AND: [{ id: userId }, visibleWhere(scope, domains)] },
    include: { scimLink: true },
  });
};

/** Without a filter, only the connection's managed users are listed. */
export const listVisibleUsers = async (
  scope: VisibilityScope,
  filter: ScimFilter,
  page: { skip: number; take: number },
  tx?: Tx
) => {
  const domains = await listProviderDomains(scope.providerId, tx);
  const where: Prisma.UserWhereInput = {
    AND: [
      { userType: "human", id: { not: SYSTEM_USER_ID } },
      filter.length === 0
        ? managed(scope.connectionId)
        : visibleWhere(scope, domains),
      ...filter.map((c) => clauseWhere(scope.connectionId, c)),
    ],
  };
  const client = tx ?? prisma;
  const [items, total] = await Promise.all([
    client.user.findMany({
      where,
      include: { scimLink: true },
      orderBy: { id: "asc" },
      skip: page.skip,
      take: page.take,
    }),
    client.user.count({ where }),
  ]);
  return { items, total };
};
