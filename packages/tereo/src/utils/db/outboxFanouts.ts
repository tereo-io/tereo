import type { Prisma } from "./prisma.js";
import { prisma } from "./prisma.js";

/**
 * `webhooks.outbox_fanouts`: the outbox events already fanned out to webhook
 * deliveries. The row is written in the transaction that writes the
 * deliveries, so it exists exactly when they do.
 */

/**
 * Records `outboxId` as fanned out, in the caller's transaction. False when it
 * already was: that transaction's deliveries were committed, and nothing is
 * to be written again. A concurrent claim of the same id waits on this one's
 * transaction and then gets false.
 */
export const claim = async (
  tx: Prisma.TransactionClient,
  outboxId: string
): Promise<boolean> =>
  (await tx.$executeRaw`
    INSERT INTO "webhooks"."outbox_fanouts" ("outbox_id")
    VALUES (${outboxId}::uuid)
    ON CONFLICT ("outbox_id") DO NOTHING
  `) > 0;

export const exists = async (outboxId: string): Promise<boolean> =>
  (await prisma.webhookOutboxFanout.count({ where: { outboxId } })) > 0;

/**
 * Deletes up to `limit` rows created before `cutoff` whose outbox row is gone:
 * one still in `core.outbox` (a dead letter that may be replayed) keeps it.
 */
export const deleteBefore = async (
  cutoff: Date,
  limit: number
): Promise<number> =>
  prisma.$executeRaw`
    DELETE FROM "webhooks"."outbox_fanouts"
    WHERE "outbox_id" IN (
      SELECT f."outbox_id" FROM "webhooks"."outbox_fanouts" f
      WHERE f."created_at" < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM "core"."outbox" o WHERE o."id" = f."outbox_id"
        )
      LIMIT ${limit}
    )
  `;
