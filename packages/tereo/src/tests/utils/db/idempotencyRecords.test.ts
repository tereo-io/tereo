// @module-tag int
// @module-tag files
// @module-tag race
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getIdempotencySweepQueue } from "../../../jobs/queues.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { Client } from "pg";

describe("db.idempotencyRecords.sweepExpired", () => {
  const waitForBlockedSweep = async () => {
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%DELETE FROM "files"."idempotency_records"%'`;
      if (Number(rows[0].n) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the sweep never blocked on the row lock");
  };
  const scope = `sweep-test-${crypto.randomUUID()}`;

  // The running server's worker sweeps every expired record, this test's
  // included, whenever its job runs (the first test's resume leaves one due).
  // Paused, and idle, it cannot delete the row between its creation and the
  // writer's UPDATE.
  beforeAll(async () => {
    const queue = getIdempotencySweepQueue();
    await queue.pause();
    for (let i = 0; i < 400 && (await queue.getActiveCount()) > 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await queue.getActiveCount()).toBe(0);
  });

  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({ where: { scope } });
    await getIdempotencySweepQueue().resume();
  });

  it("keeps an expired record that a request refreshes while the sweep waits on it", async () => {
    await prisma.idempotencyRecord.create({
      data: {
        scope,
        key: "k",
        requestHash: "old",
        responseStatus: 201,
        responseBody: {},
        createdBy: SYSTEM_USER_ID,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    // withIdempotency's refresh of the expired row, held open until the
    // sweep is blocked behind it.
    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    await writer.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        `UPDATE "files"."idempotency_records"
         SET request_hash = 'new', expires_at = NOW() + interval '1 day'
         WHERE scope = $1 AND key = 'k'`,
        [scope]
      );
      const sweep = db.idempotencyRecords.sweepExpired(500);
      await waitForBlockedSweep();
      await writer.query("COMMIT");
      await sweep;
    } finally {
      await writer.end();
    }

    const row = await prisma.idempotencyRecord.findFirst({
      where: { scope, key: "k" },
    });
    expect(row?.requestHash).toBe("new");
  });
});
