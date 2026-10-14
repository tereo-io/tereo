import { Prisma } from "../../../prisma/generated/client/index.js";
import { prisma } from "./prisma.js";

/**
 * Dead-lettered rows of `core.outbox`. The reaper's own claims and writes live
 * with it in `utils/outbox.ts`.
 */

/** Narrows which dead letters a replay touches. Empty matches every one. */
export interface DeadLetterFilter {
  ids?: string[];
  destination?: string;
  /** Dead-lettered at or after this. */
  since?: Date;
}

const deadLetterWhere = (filter: DeadLetterFilter): Prisma.Sql => {
  const conditions = [Prisma.sql`dead_lettered_at IS NOT NULL`];
  if (filter.ids && filter.ids.length > 0) {
    conditions.push(Prisma.sql`id = ANY(${filter.ids}::uuid[])`);
  }
  if (filter.destination !== undefined) {
    conditions.push(Prisma.sql`destination = ${filter.destination}`);
  }
  if (filter.since !== undefined) {
    conditions.push(Prisma.sql`dead_lettered_at >= ${filter.since}`);
  }
  return Prisma.join(conditions, " AND ");
};

export const countDeadLetters = async (
  filter: DeadLetterFilter
): Promise<number> => {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM "core"."outbox"
    WHERE ${deadLetterWhere(filter)}
  `;
  return Number(row.count);
};

/**
 * Returns matching dead letters to the reaper: due now by the database's
 * clock, which the reaper's claim compares against, with a fresh attempt
 * budget. `last_error` stays until the next attempt replaces it.
 */
export const replayDeadLetters = async (
  filter: DeadLetterFilter
): Promise<number> =>
  prisma.$executeRaw`
    UPDATE "core"."outbox"
    SET dead_lettered_at = NULL,
        attempts = 0,
        next_attempt_at = NOW(),
        claimed_at = NULL,
        claimed_by = NULL
    WHERE ${deadLetterWhere(filter)}
  `;

/** Deletes up to `limit` rows dead-lettered before `cutoff`. */
export const deleteDeadLettersBefore = async (
  cutoff: Date,
  limit: number
): Promise<number> =>
  prisma.$executeRaw`
    DELETE FROM "core"."outbox"
    WHERE id IN (
      SELECT id FROM "core"."outbox"
      WHERE dead_lettered_at < ${cutoff}
      LIMIT ${limit}
    )
    -- Re-checked after a row lock wait, unlike the subquery: a row replayed
    -- meanwhile is no longer a dead letter and must survive.
    AND dead_lettered_at < ${cutoff}
  `;
