import { prisma } from "./prisma.js";
import type {
  Prisma,
  UserType,
} from "../../../prisma/generated/client/index.js";

export type ReportRow = {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  userType: UserType;
  reportsToId: string;
  depth: number;
};

/**
 * Serializes every change to the reports-to graph, so two changes that are each
 * acyclic alone cannot together make a loop. Taken first in the transaction.
 */
export const lockHierarchy = async (
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:user-hierarchy', 0))`;
};

/** Ids above `userId`, nearest first. The path array stops a corrupt loop. */
export const chainAbove = async (
  userId: string,
  tx: Prisma.TransactionClient
): Promise<string[]> => {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE chain AS (
      SELECT u.reports_to_id AS id, 1 AS depth, ARRAY[u.id, u.reports_to_id] AS path
      FROM "auth"."users" u
      WHERE u.id = ${userId}::uuid AND u.reports_to_id IS NOT NULL
      UNION ALL
      SELECT u.reports_to_id, c.depth + 1, c.path || u.reports_to_id
      FROM chain c
      JOIN "auth"."users" u ON u.id = c.id
      WHERE u.reports_to_id IS NOT NULL AND u.reports_to_id <> ALL (c.path)
    )
    SELECT id FROM chain ORDER BY depth
  `;
  return rows.map((r) => r.id);
};

/**
 * Users below `userId`, whatever their is_active or user_type, so a
 * deactivated user does not cut the tree. Fetches one row past `maxUsers` and
 * recurses one level past `maxDepth` to tell a full tree from a cut one.
 */
export const listBelow = async (
  userId: string,
  opts: { transitive: boolean; maxUsers: number; maxDepth: number },
  tx?: Prisma.TransactionClient
): Promise<{ rows: ReportRow[]; overLimit: boolean }> => {
  const db = tx ?? prisma;
  const levels = opts.transitive ? opts.maxDepth + 1 : 1;
  const fetched = await db.$queryRaw<ReportRow[]>`
    WITH RECURSIVE below AS (
      SELECT u.id, u.email, u.name, u.is_active, u.user_type, u.reports_to_id,
             1 AS depth, ARRAY[${userId}::uuid, u.id] AS path
      FROM "auth"."users" u
      WHERE u.reports_to_id = ${userId}::uuid
      UNION ALL
      SELECT u.id, u.email, u.name, u.is_active, u.user_type, u.reports_to_id,
             b.depth + 1, b.path || u.id
      FROM below b
      JOIN "auth"."users" u ON u.reports_to_id = b.id
      WHERE b.depth < ${levels}::int AND u.id <> ALL (b.path)
    )
    SELECT id, email, name, is_active AS "isActive", user_type AS "userType",
           reports_to_id AS "reportsToId", depth::int AS depth
    FROM below
    ORDER BY depth, email
    LIMIT ${opts.maxUsers + 1}
  `;
  const tooDeep =
    opts.transitive && fetched.some((r) => r.depth > opts.maxDepth);
  const tooMany = fetched.length > opts.maxUsers;
  const rows = fetched
    .filter((r) => r.depth <= opts.maxDepth || !opts.transitive)
    .slice(0, opts.maxUsers);
  return { rows, overLimit: tooDeep || tooMany };
};

export const countDirect = (userId: string): Promise<number> =>
  prisma.user.count({ where: { reportsToId: userId } });

export const setReportsTo = async (
  userId: string,
  reportsToId: string | null,
  tx: Prisma.TransactionClient
): Promise<void> => {
  await tx.user.update({ where: { id: userId }, data: { reportsToId } });
};
