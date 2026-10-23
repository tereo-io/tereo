// @module-tag int
// @module-tag notifications
// @module-tag webhooks
import { dispatchNotification } from "../../utils/notifications/dispatch.js";
import { dispatchOutboxEvent } from "../../utils/processEvent.js";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { waitFor } from "../support/webhooks.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../jobs/notificationQueues.js";
import {
  createOutboxReaper,
  notifyTx,
  type OutboxDispatcher,
} from "../../utils/outbox.js";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";

const input = {
  channel: "email" as const,
  recipients: [{ address: "ops@example.com" }],
  content: { subject: "Core says hello", text: "Hello" },
};

const outboxRows = (id: string) =>
  prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "core"."outbox"
    WHERE destination = 'notification' AND payload->>'notificationId' = ${id}`;

describe("notifyTx", () => {
  const created: string[] = [];

  beforeAll(async () => {
    await ensureDailyPartitions("notifications", 0, 1);
    await ensureDailyPartitions("notificationDeliveries", 0, 1);
  });

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({
      where: { notificationId: { in: created } },
    });
    await prisma.notification.deleteMany({ where: { id: { in: created } } });
    await closeNotificationQueues();
  });

  it("writes nothing when the transaction rolls back", async () => {
    let id: string | undefined;
    await expect(
      prisma.$transaction(async (tx) => {
        id = (await notifyTx(tx, input)).id;
        throw new Error("rolled back");
      })
    ).rejects.toThrow("rolled back");

    expect(id).toBeDefined();
    expect(await prisma.notification.findFirst({ where: { id } })).toBeNull();
    expect(await outboxRows(id!)).toHaveLength(0);
  });

  it("writes the notification and its outbox row on commit, sent by core", async () => {
    // Read inside the transaction: once it commits, the server's reaper may
    // dispatch the row and delete it before this test looks.
    const { id, outbox } = await prisma.$transaction(async (tx) => {
      const { id } = await notifyTx(tx, input);
      const outbox = await tx.$queryRaw<{ payload: unknown }[]>`
        SELECT payload FROM "core"."outbox"
        WHERE destination = 'notification' AND payload->>'notificationId' = ${id}`;
      return { id, outbox };
    });
    created.push(id);

    const row = await prisma.notification.findFirstOrThrow({
      where: { id },
      include: { deliveries: true },
    });
    expect(row.senderUserId).toBe(SYSTEM_USER_ID);
    expect(row.deliveries).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toEqual({
      notificationId: id,
      createdAt: row.createdAt.toISOString(),
    });
    // Committed: dispatched from the outbox onto the channel's queue.
    const queue = getNotificationQueue("email");
    await waitFor(
      async () => (await queue.getJob(row.deliveries[0].id)) !== undefined
    );
  });

  it("runs the same checks as the API", async () => {
    await expect(
      prisma.$transaction((tx) =>
        notifyTx(tx, { ...input, content: { subject: "No body" } })
      )
    ).rejects.toMatchObject({ code: "invalid_content" });
  });
});

describe("createOutboxReaper", () => {
  const DESTINATION = "reaper-test";

  // The server's own reaper runs against this database too. Test rows start
  // claimed by another worker a second ago: fresh to the server's reaper, whose
  // claims last a minute, and stale to a test reaper with `claimTtlMs: 0`. They
  // fell due long ago, so a batch takes them ahead of other suites' rows.
  const insertClaimed = async (count: number): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "core"."outbox" ("id", "destination", "payload", "claimed_at", "claimed_by", "next_attempt_at")
    SELECT gen_random_uuid(), ${DESTINATION}, '{}'::jsonb, NOW() - INTERVAL '1 second', 'elsewhere', '2000-01-01'
    FROM generate_series(1, ${count}::int)
    RETURNING "id"::text
  `;
    return rows.map((r) => r.id);
  };

  const rowsOf = (ids: string[]) =>
    prisma.outbox.findMany({ where: { id: { in: ids } } });

  // Run one tick: `start` claims a batch at once, `stop` waits for it.
  const runOnce = async (
    dispatch: OutboxDispatcher,
    options: {
      claimTtlMs?: number;
      batchSize?: number;
      dispatchConcurrency?: number;
    } = {}
  ) => {
    const reaper = createOutboxReaper({
      dispatchers: {
        [DESTINATION]: dispatch,
        // Any server row it re-claims is dispatched as the server would.
        webhook: (payload, row) =>
          dispatchOutboxEvent(payload, row.id, row.created_at),
        notification: (payload) => dispatchNotification(payload),
      },
      workerId: "test-reaper",
      pollIntervalMs: 60_000,
      claimTtlMs: 0,
      ...options,
    });
    reaper.start();
    await reaper.stop();
  };

  describe("outbox reaper", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await prisma.outbox.deleteMany({ where: { destination: DESTINATION } });
    });

    it("dispatches a batch at most ten rows at a time", async () => {
      const ids = await insertClaimed(30);
      let active = 0;
      let peak = 0;
      const seen = new Set<string>();

      await runOnce(
        async (_payload, row) => {
          if (!ids.includes(row.id)) return;
          seen.add(row.id);
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 30));
          active--;
        },
        { batchSize: 200 }
      );

      expect(seen.size).toBe(30);
      expect(peak).toBeLessThanOrEqual(10);
      expect(await rowsOf(ids)).toHaveLength(0);
    });

    it("leaves a row re-claimed during dispatch to its new claimer", async () => {
      const [done] = await insertClaimed(1);
      const [failed] = await insertClaimed(1);
      const reclaim = (id: string) => prisma.$executeRaw`
      UPDATE "core"."outbox" SET claimed_by = 'other', claimed_at = NOW()
      WHERE id = ${id}::uuid`;

      await runOnce(async (_payload, row) => {
        if (row.id === done) await reclaim(done);
        if (row.id === failed) {
          await reclaim(failed);
          throw new Error("dispatch failed");
        }
      });

      const rows = await rowsOf([done, failed]);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.claimedBy).toBe("other");
        expect(row.claimedAt).not.toBeNull();
        expect(row.attempts).toBe(0);
        expect(row.lastError).toBeNull();
      }
    });

    it("skips a row another worker claimed before its turn in the batch", async () => {
      const ids = await insertClaimed(2);
      const seen: string[] = [];

      await runOnce(
        async (_payload, row) => {
          if (!ids.includes(row.id)) return;
          seen.push(row.id);
          // While the first of the two runs (a batch has no set order), the
          // other outlives the claim and another worker takes it.
          if (seen.length === 1) {
            const other = ids.find((id) => id !== row.id)!;
            await prisma.$executeRaw`
            UPDATE "core"."outbox" SET claimed_by = 'other', claimed_at = NOW()
            WHERE id = ${other}::uuid`;
          }
        },
        { dispatchConcurrency: 1 }
      );

      expect(seen).toHaveLength(1);
      const [left] = await rowsOf(ids.filter((id) => id !== seen[0]));
      expect(left.claimedBy).toBe("other");
    });

    it("judges a claim stale by the database's clock, not its own", async () => {
      const [id] = await insertClaimed(1);
      const realNow = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(realNow + 60 * 60 * 1000);
      const dispatch = vi.fn(async () => {});

      await runOnce(dispatch, { claimTtlMs: 60_000 });

      expect(dispatch).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id })
      );
      const [row] = await rowsOf([id]);
      expect(row.claimedBy).toBe("elsewhere");
    });
  });
});
