import type { ScimUser as ScimUserLink } from "../../../prisma/generated/client/index.js";
import type { User } from "../../../prisma/generated/client/index.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { emailDomain, normalizeEmail } from "../email.js";
import type { ScimFilter } from "../scim/filter.js";
import { NotFoundError } from "../errors.js";
import { prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export type { ScimUserLink };

// A resource the IdP can still address: neither deleted by it nor unlinked
// by an admin.
const LIVE = { deletedAt: null, unlinkedAt: null } as const;

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

/**
 * Serializes writers to one connection's groups. `FOR NO KEY UPDATE`, not
 * `lockConnection`'s `FOR UPDATE`: a SCIM user write inserts a `scim_users`
 * row, which takes `FOR KEY SHARE` on the connection and must not queue behind
 * a group write that waits on locks the user write holds.
 */
export const lockConnectionForGroups = async (id: string, tx: Tx) => {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "auth"."scim_connections" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE
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

export type GroupsTarget =
  | { kind: "none" | "global" }
  | { kind: "organization"; organizationId: string };

export const setGroupsTarget = async (
  connectionId: string,
  target: GroupsTarget,
  tx: Tx
) => {
  return await tx.scimConnection.update({
    where: { id: connectionId },
    data: {
      groupsTarget: target.kind,
      groupsOrganizationId:
        target.kind === "organization" ? target.organizationId : null,
    },
  });
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

/** Any row of the user's, unlinked or deleted included. */
export const getLinkByUser = async (userId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimUser.findUnique({ where: { userId } });
};

/** The link that manages the user, deleted resources included; null once unlinked. */
export const getManagingLink = async (userId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimUser.findFirst({
    where: { userId, unlinkedAt: null },
  });
};

/** With the connection's provider; includes deleted and unlinked rows. */
export const getLinkWithProvider = async (userId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimUser.findUnique({
    where: { userId },
    include: { connection: { include: { provider: true } } },
  });
};

export const userNameKey = (userName: string): string => userName.toLowerCase();

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
  return await tx.scimUser.create({
    data: { ...input, userNameKey: userNameKey(input.userName) },
  });
};

export const updateLink = async (
  id: string,
  data: Partial<
    Pick<
      ScimUserLink,
      | "externalId"
      | "userName"
      | "idpActive"
      | "adminHold"
      | "deletedAt"
      | "unlinkedAt"
    >
  >,
  tx: Tx
) => {
  return await tx.scimUser.update({
    where: { id },
    data: {
      ...data,
      ...(data.userName !== undefined && {
        userNameKey: userNameKey(data.userName),
      }),
    },
  });
};

export const deleteLink = async (id: string, tx: Tx) => {
  await tx.scimUser.delete({ where: { id } });
};

/** The ids among `userIds` with a live link (deletedAt and unlinkedAt null) on the connection. */
export const filterLiveLinked = async (
  connectionId: string,
  userIds: string[],
  tx: Tx
): Promise<string[]> => {
  if (userIds.length === 0) return [];
  const rows = await tx.scimUser.findMany({
    where: { connectionId, userId: { in: userIds }, ...LIVE },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
};

/** Links that manage a user: deleted resources count, unlinked rows do not. */
export const countLinks = async (connectionId: string, tx?: Tx) => {
  return await (tx ?? prisma).scimUser.count({
    where: { connectionId, unlinkedAt: null },
  });
};

export const deleteUnlinked = async (connectionId: string, tx: Tx) => {
  await tx.scimUser.deleteMany({
    where: { connectionId, unlinkedAt: { not: null } },
  });
};

const isLive = (
  link: Pick<ScimUserLink, "connectionId" | "deletedAt" | "unlinkedAt">,
  connectionId: string
) =>
  link.connectionId === connectionId &&
  link.deletedAt === null &&
  link.unlinkedAt === null;

type UserWithLink = User & { scimLink: ScimUserLink | null };

const userByEmail = async (
  email: string,
  tx?: Tx
): Promise<UserWithLink | null> =>
  await (tx ?? prisma).user.findUnique({
    where: { email: normalizeEmail(email) },
    include: { scimLink: true },
  });

const linkByUserName = async (
  connectionId: string,
  userName: string,
  tx?: Tx
) =>
  await (tx ?? prisma).scimUser.findUnique({
    where: {
      connectionId_userNameKey: {
        connectionId,
        userNameKey: userNameKey(userName),
      },
    },
    include: { user: { include: { scimLink: true } } },
  });

const linkByExternalId = async (
  connectionId: string,
  externalId: string,
  tx?: Tx
) =>
  await (tx ?? prisma).scimUser.findFirst({
    where: { connectionId, externalId, ...LIVE },
    include: { user: { include: { scimLink: true } } },
  });

/**
 * Live links of the connection matching an external id, or whose user's core
 * email is `email`, in any case; the caller decides which are
 * claimable.
 */
export const findClaimable = async (
  connectionId: string,
  by: { externalId: string } | { email: string },
  tx?: Tx
): Promise<ScimUserLink[]> => {
  if ("externalId" in by) {
    const link = await linkByExternalId(connectionId, by.externalId, tx);
    return link ? [link] : [];
  }
  const link = (await userByEmail(by.email, tx))?.scimLink;
  return link && isLive(link, connectionId) ? [link] : [];
};

/**
 * A live link of the connection whose user has `email`, or holding `userName`
 * (in any case) or `externalId`; null when there is none.
 */
export const findLiveConflict = async (
  connectionId: string,
  by: { email: string; userName: string; externalId: string | null },
  tx?: Tx
): Promise<{ id: string } | null> => {
  const byEmail = (await userByEmail(by.email, tx))?.scimLink;
  if (byEmail && isLive(byEmail, connectionId)) return { id: byEmail.id };
  const byName = await linkByUserName(connectionId, by.userName, tx);
  if (byName && isLive(byName, connectionId)) return { id: byName.id };
  if (by.externalId === null) return null;
  const byExternal = await linkByExternalId(connectionId, by.externalId, tx);
  return byExternal ? { id: byExternal.id } : null;
};

/**
 * Whether a live link of the provider's connection names a user with no
 * identity at the provider: a standing invite its next sign-in may claim.
 */
export const hasUnclaimedLinks = async (providerId: string, tx?: Tx) => {
  const row = await (tx ?? prisma).scimUser.findFirst({
    where: {
      connection: { providerId },
      ...LIVE,
      user: { identities: { none: { providerId } } },
    },
    select: { id: true },
  });
  return row !== null;
};

interface VisibilityScope {
  connectionId: string;
  providerId: string;
}

export const listProviderDomains = async (providerId: string, tx?: Tx) => {
  const rows = await (tx ?? prisma).identityProviderDomain.findMany({
    where: { providerId },
    select: { domain: true },
  });
  return rows.map((r) => r.domain.toLowerCase());
};

/**
 * A human the connection manages (a live link), or one with no link at all
 * whose email domain is one of the provider's. Any other link, deleted or
 * unlinked or another connection's, hides the user.
 */
const isVisible = async (
  scope: VisibilityScope,
  user: UserWithLink,
  domains: () => Promise<string[]>
): Promise<boolean> => {
  if (user.userType !== "human" || user.id === SYSTEM_USER_ID) return false;
  if (user.scimLink) return isLive(user.scimLink, scope.connectionId);
  return (await domains()).includes(emailDomain(user.email));
};

// The provider's domains, read once and only when a user needs them.
const domainsOnce = (providerId: string, tx?: Tx) => {
  let read: Promise<string[]> | undefined;
  return () => (read ??= listProviderDomains(providerId, tx));
};

export const findVisibleUser = async (
  scope: VisibilityScope,
  userId: string,
  tx?: Tx
): Promise<UserWithLink | null> => {
  const user = await (tx ?? prisma).user.findUnique({
    where: { id: userId },
    include: { scimLink: true },
  });
  if (!user) return null;
  const visible = await isVisible(
    scope,
    user,
    domainsOnce(scope.providerId, tx)
  );
  return visible ? user : null;
};

const matchesClause = (
  connectionId: string,
  user: UserWithLink,
  clause: ScimFilter[number]
): boolean => {
  const link =
    user.scimLink && isLive(user.scimLink, connectionId) ? user.scimLink : null;
  switch (clause.attr) {
    case "email":
      return user.email === normalizeEmail(clause.value);
    case "externalId":
      return link?.externalId === clause.value;
    case "userName":
      // An unmanaged user has no userName yet: it is their email.
      return link
        ? link.userNameKey === userNameKey(clause.value)
        : user.scimLink === null && user.email === normalizeEmail(clause.value);
  }
};

// Each clause is an equality on a unique value, so it names at most a user
// by link and one by email.
const candidatesFor = async (
  connectionId: string,
  clause: ScimFilter[number]
): Promise<UserWithLink[]> => {
  switch (clause.attr) {
    case "email": {
      const user = await userByEmail(clause.value);
      return user ? [user] : [];
    }
    case "externalId": {
      const link = await linkByExternalId(connectionId, clause.value);
      return link ? [link.user] : [];
    }
    case "userName": {
      const link = await linkByUserName(connectionId, clause.value);
      const user = await userByEmail(clause.value);
      return [link?.user, user].filter((u): u is UserWithLink => !!u);
    }
  }
};

const managedWhere = (connectionId: string): Prisma.UserWhereInput => ({
  userType: "human",
  id: { not: SYSTEM_USER_ID },
  scimLink: { is: { connectionId, ...LIVE } },
});

/** Without a filter, only the connection's managed users are listed. */
export const listVisibleUsers = async (
  scope: VisibilityScope,
  filter: ScimFilter,
  page: { skip: number; take: number }
): Promise<{ items: UserWithLink[]; total: number }> => {
  if (filter.length === 0) {
    const where = managedWhere(scope.connectionId);
    // One snapshot, so the total and the page agree.
    const [items, total] = await prisma.$transaction(
      [
        prisma.user.findMany({
          where,
          include: { scimLink: true },
          orderBy: { id: "asc" },
          skip: page.skip,
          take: page.take,
        }),
        prisma.user.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    return { items, total };
  }

  const domains = domainsOnce(scope.providerId);
  const found = new Map<string, UserWithLink>();
  for (const user of await candidatesFor(scope.connectionId, filter[0])) {
    if (
      filter.every((c) => matchesClause(scope.connectionId, user, c)) &&
      (await isVisible(scope, user, domains))
    ) {
      found.set(user.id, user);
    }
  }
  const all = [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    items: all.slice(page.skip, page.skip + page.take),
    total: all.length,
  };
};
