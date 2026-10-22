// @module-tag int
// @module-tag webhooks
// @module-tag job
// @module-tag race
import { runOutboxRetention } from "../../jobs/outboxRetention.js";
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { Client } from "pg";

describe("runOutboxRetention", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  const waitForBlockedRetention = async () => {
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query LIKE '%DELETE FROM "core"."outbox"%'`;
      if (Number(rows[0].n) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("retention never blocked on the row lock");
  };

  describe("outbox retention during a replay", () => {
    let id: string | undefined;

    afterAll(async () => {
      if (id) await prisma.outbox.deleteMany({ where: { id } });
    });

    it("keeps an old dead letter that is replayed while retention waits on it", async () => {
      const row = await prisma.outbox.create({
        data: {
          destination: "retention-replay-test",
          payload: {},
          // Keeps the reaper off the row once it is replayed.
          nextAttemptAt: new Date(Date.now() + DAY_MS),
          attempts: 10,
          deadLetteredAt: new Date(Date.now() - 365 * DAY_MS),
        },
      });
      id = row.id;

      // replayDeadLetters' update, held open until retention is blocked behind it.
      const replay = new Client({ connectionString: process.env.DATABASE_URL });
      await replay.connect();
      try {
        await replay.query("BEGIN");
        await replay.query(
          `UPDATE "core"."outbox"
         SET dead_lettered_at = NULL, attempts = 0,
             next_attempt_at = NOW() + interval '1 day'
         WHERE id = $1::uuid AND dead_lettered_at IS NOT NULL`,
          [row.id]
        );
        const retention = runOutboxRetention();
        await waitForBlockedRetention();
        await replay.query("COMMIT");
        await retention;
      } finally {
        await replay.end();
      }

      const after = await prisma.outbox.findUnique({ where: { id: row.id } });
      expect(after).not.toBeNull();
      expect(after?.deadLetteredAt).toBeNull();
    });
  });
});
