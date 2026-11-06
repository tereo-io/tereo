/**
 * User lookups for code outside the auth routes — bucket grants resolving
 * user details, and the startup check for the system user.
 */
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { prisma, type Prisma } from "./db/prisma.js";
import { toUserRef, type UserRef } from "./refs.js";
import { formatUser } from "./transformers.js";

export type User = ReturnType<typeof formatUser>;

interface AccountStanding {
  isActive: boolean;
  expiresAt: Date | null;
}

/**
 * Whether the account may sign in and act: active, and not past its expiry.
 * An expired account keeps `isActive`, so every sign-in and token check goes
 * through here rather than reading `isActive` alone.
 */
export const isUsableAccount = (
  user: AccountStanding,
  now: Date = new Date()
): boolean =>
  user.isActive && (user.expiresAt === null || user.expiresAt > now);

/** `isUsableAccount` as a Prisma filter on the user. */
export const usableAccountWhere = (
  now: Date = new Date()
): Prisma.UserWhereInput => ({
  isActive: true,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

/** Whole seconds until the account expires, never negative; null if it never does. */
export const remainingSeconds = (
  user: Pick<AccountStanding, "expiresAt">,
  now: Date = new Date()
): number | null =>
  user.expiresAt === null
    ? null
    : Math.max(
        0,
        Math.floor((user.expiresAt.getTime() - now.getTime()) / 1000)
      );

/** Fetch users by id. Ids with no user map to `null`. */
export const getUsers = async (
  ids: string[]
): Promise<Map<string, User | null>> => {
  const unique = [...new Set(ids)];
  const rows = await prisma.user.findMany({ where: { id: { in: unique } } });
  const found = new Map(rows.map((u) => [u.id, formatUser(u)]));
  return new Map(unique.map((id) => [id, found.get(id) ?? null]));
};

/**
 * Add a `UserRef` for each actor column of each row, from one lookup for the
 * whole page. `fields` maps the new key to the id column, e.g.
 * `{ deletedByUser: "deletedBy" }`; a null id, or one naming no user, gives
 * null.
 */
export const withUserRefs = async <
  T extends object,
  F extends Record<string, keyof T>,
>(
  rows: T[],
  fields: F
): Promise<(T & { [K in keyof F]: UserRef | null })[]> => {
  const columns = Object.values(fields);
  const ids = rows.flatMap((row) =>
    columns.flatMap((column) => {
      const id = row[column];
      return typeof id === "string" ? [id] : [];
    })
  );
  const users =
    ids.length > 0 ? await getUsers(ids) : new Map<string, User | null>();
  return rows.map((row) => {
    const refs: Record<string, UserRef | null> = {};
    for (const [key, column] of Object.entries(fields)) {
      const id = row[column];
      refs[key] = typeof id === "string" ? toUserRef(users.get(id)) : null;
    }
    return { ...row, ...refs } as T & { [K in keyof F]: UserRef | null };
  });
};

const getUser = async (id: string): Promise<User | null> =>
  (await getUsers([id])).get(id) ?? null;

export const userExists = async (id: string): Promise<boolean> =>
  (await getUser(id)) !== null;

/**
 * Whether the user can hold a token for the organization: a member, or the
 * service-account user of a client bound to it (client-credentials tokens
 * carry the client's organization without a membership).
 */
export const canActInOrganization = async (
  userId: string,
  organizationId: string
): Promise<boolean> => {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      OR: [
        { organizationMembers: { some: { organizationId } } },
        { oauthClient: { organizationId } },
      ],
    },
    select: { id: true },
  });
  return user !== null;
};

/**
 * The organizations the user can hold a token for, as in
 * `canActInOrganization`: their memberships and their client's organization.
 */
export const actingOrganizationIds = async (
  userId: string
): Promise<string[]> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      organizationMembers: { select: { organizationId: true } },
      oauthClient: { select: { organizationId: true } },
    },
  });
  if (!user) return [];
  const ids = user.organizationMembers.map((m) => m.organizationId);
  const clientOrg = user.oauthClient?.organizationId;
  if (clientOrg && !ids.includes(clientOrg)) ids.push(clientOrg);
  return ids;
};

/**
 * Fail startup if the seed has not created core's system user — every
 * system write names it, and the foreign keys reject writes without it.
 */
export const assertSystemUser = async (): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: SYSTEM_USER_ID } });
  if (!user) {
    throw new Error(
      `System user (${SYSTEM_USER_ID}) not found — run the seed before starting.`
    );
  }
};
