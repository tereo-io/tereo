import { createScimConnection, scimFetch, setGroupsTarget } from "./scim.js";
import { makeUser, manage, tag } from "./scimUsers.js";
import { prisma } from "../../utils/db/prisma.js";
import { joinOrg } from "./groups.js";

export const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export type ScimTestConnection = Awaited<
  ReturnType<typeof createScimConnection>
>;

/** A connection whose groups land in its own organization. */
export const orgConnection = async () => {
  const c = await createScimConnection();
  await setGroupsTarget(c.connectionId, {
    kind: "organization",
    organizationId: c.organizationId,
  });
  return c;
};

/** A user the connection manages, with or without membership of its organization. */
export const managedUser = async (
  c: ScimTestConnection,
  opts: { inOrg?: boolean } = {}
) => {
  const user = await makeUser(`m-${tag()}@${c.domain}`);
  await manage(c.connectionId, user.id, user.email);
  if (opts.inOrg ?? true) await joinOrg(c.organizationId, user.id);
  return user;
};

export const putGroup = (token: string, id: string, body: unknown) =>
  scimFetch(token, "PUT", `/scim/v2/Groups/${id}`, body);

export const patchGroup = (token: string, id: string, body: unknown) =>
  scimFetch(token, "PATCH", `/scim/v2/Groups/${id}`, body);

export const getGroup = (token: string, id: string) =>
  scimFetch(token, "GET", `/scim/v2/Groups/${id}`);

export const patchOps = (...Operations: Array<Record<string, unknown>>) => ({
  schemas: [PATCH_OP],
  Operations,
});

export const asMembers = (...ids: string[]) => ids.map((value) => ({ value }));

export const memberIds = async (groupId: string) =>
  (await prisma.groupMember.findMany({ where: { groupId } }))
    .map((m) => m.userId)
    .sort();

export const skippedIds = async (groupId: string) =>
  (
    await prisma.scimGroupSkippedMember.findMany({
      where: { scimGroup: { groupId } },
    })
  )
    .map((s) => s.userId)
    .sort();

export const bodyMemberIds = (body: {
  members?: Array<{ value: string }>;
}): string[] => (body.members ?? []).map((m) => m.value).sort();

export const groupAuditActions = async (groupId: string) =>
  (
    await prisma.auditLogEntry.findMany({
      where: { entityType: "Group", entityId: groupId },
      orderBy: { id: "asc" },
    })
  ).map((e) => ({
    action: e.action,
    detail: (e.metadata as { action?: string } | null)?.action,
  }));

export const groupEventCount = (groupId: string) =>
  prisma.outbox.count({
    where: { payload: { path: ["entityId"], equals: groupId } },
  });

/** Inserts `count` plain users directly; returns their ids, ascending. */
export const seedUsers = async (count: number): Promise<string[]> => {
  const batch = tag();
  await prisma.user.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      email: `bulk-${batch}-${i}@seed.test`,
      name: "Seeded",
      userType: "human" as const,
    })),
  });
  const users = await prisma.user.findMany({
    where: { email: { startsWith: `bulk-${batch}-` } },
    select: { id: true },
  });
  return users.map((u) => u.id).sort();
};

/** Inserts `count` plain users as members of the group directly, without requests. */
export const seedMembers = async (
  groupId: string,
  count: number,
  addedBy: string
): Promise<string[]> => {
  const ids = await seedUsers(count);
  await prisma.groupMember.createMany({
    data: ids.map((userId) => ({ groupId, userId, addedBy })),
  });
  return ids;
};

/** Resolves once a session waits on the authority lock of `userId`. */
export const waitForAuthorityLockWait = async (
  userId: string,
  timeoutMs = 10_000
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) =
          hashtextextended(${`core:user-authority:${userId}`}, 0)`;
    if (Number(row.n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No session waited on the authority lock of ${userId}`);
};
