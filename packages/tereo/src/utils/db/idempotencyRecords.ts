import { prisma } from "./prisma.js";

/** Deletes up to `limit` expired idempotency records and returns the count. */
export const sweepExpired = async (limit: number): Promise<number> => {
  const deleted = await prisma.$executeRaw`
    DELETE FROM "files"."idempotency_records"
    WHERE "id" IN (
      SELECT "id"
      FROM "files"."idempotency_records"
      WHERE "expires_at" < NOW()
      ORDER BY "id" ASC
      LIMIT ${limit}
    )
    -- A DELETE that waited on a row lock re-checks only its own WHERE, not the
    -- subquery's: without this, a record refreshed by a request meanwhile
    -- would be deleted.
    AND "expires_at" < NOW()
  `;
  return Number(deleted);
};
