// @module-tag int
// @module-tag files
// @module-tag job
// @module-tag race
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { getIdempotencySweepQueue } from "../../jobs/queues.js";
import { getRedisClient } from "../../utils/redis.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { Client } from "pg";
import {
  startIdempotencySweep,
  stopIdempotencySweep,
} from "../../jobs/idempotencySweep.js";

const HOUR_MS = 60 * 60 * 1000;

const SCHEDULER = "idempotency-sweep-scheduler";

describe("startIdempotencySweep", () => {
  it("installs a job's current schedule on every start", async () => {
    const redis = getRedisClient();
    const queue = getIdempotencySweepQueue();
    // An earlier start, moments ago, with a different interval; the lease
    // that once gated the upsert is still held.
    await redis.set(
      `file-service:scheduler-leader:${SCHEDULER}`,
      "1",
      "EX",
      600
    );
    // Paused, so no worker starts a sweep this test then closes under it.
    await queue.pause();
    await queue.upsertJobScheduler(
      SCHEDULER,
      { every: 2 * HOUR_MS },
      { name: "idempotency-sweep" }
    );

    try {
      await startIdempotencySweep();
      expect((await queue.getJobScheduler(SCHEDULER))?.every).toBe(HOUR_MS);
    } finally {
      await stopIdempotencySweep();
      await redis.del(`file-service:scheduler-leader:${SCHEDULER}`);
      await queue.upsertJobScheduler(
        SCHEDULER,
        { every: HOUR_MS },
        { name: "idempotency-sweep" }
      );
      await queue.resume();
    }
  });
});

describe("db.idempotencyRecords.sweepExpired", () => {
  const waitForBlockedSweep = async () => {
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query LIKE '%DELETE FROM "files"."idempotency_records"%'`;
      if (Number(rows[0].n) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the sweep never blocked on the row lock");
  };
  const scope = `sweep-test-${crypto.randomUUID()}`;

  afterAll(async () => {
    await prisma.idempotencyRecord.deleteMany({ where: { scope } });
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
