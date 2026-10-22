// @module-tag int
// @module-tag webhooks
// @module-tag job
import { runOutboxRetention } from "../../jobs/outboxRetention.js";
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";

const DESTINATION = "dead-letter-test";
const DAY_MS = 24 * 60 * 60 * 1000;

const insertDeadLetter = async (
  destination: string,
  payload: unknown,
  deadLetteredAt: Date = new Date()
): Promise<string> => {
  const row = await prisma.outbox.create({
    data: {
      destination,
      payload: payload as object,
      attempts: 100,
      lastError: "endpoint lookup failed",
      deadLetteredAt,
    },
  });
  return row.id;
};

describe("runOutboxRetention", () => {
  describe("outbox dead letters", () => {
    afterAll(async () => {
      await prisma.outbox.deleteMany({
        where: { destination: { startsWith: DESTINATION } },
      });
    });

    describe("retention", () => {
      it("deletes dead letters older than the retention and keeps recent ones", async () => {
        // OUTBOX_DEAD_LETTER_RETENTION_DAYS defaults to 30.
        const expired = await insertDeadLetter(
          DESTINATION,
          {},
          new Date(Date.now() - 31 * DAY_MS)
        );
        const kept = await insertDeadLetter(
          DESTINATION,
          {},
          new Date(Date.now() - 29 * DAY_MS)
        );

        const result = await runOutboxRetention();

        expect(result.deadLetters).toBeGreaterThanOrEqual(1);
        expect(await prisma.outbox.count({ where: { id: expired } })).toBe(0);
        expect(await prisma.outbox.count({ where: { id: kept } })).toBe(1);
      });

      it("deletes old fan-out records whose outbox row is gone, and keeps the rest", async () => {
        const old = new Date(Date.now() - 31 * DAY_MS);
        const gone = crypto.randomUUID();
        const recent = crypto.randomUUID();
        // Still in the outbox, dead-lettered recently: a replay may bring it back.
        const pending = await insertDeadLetter(DESTINATION, {});
        await prisma.webhookOutboxFanout.createMany({
          data: [
            { outboxId: gone, createdAt: old },
            { outboxId: recent },
            { outboxId: pending, createdAt: old },
          ],
        });

        const result = await runOutboxRetention();

        expect(result.fanouts).toBeGreaterThanOrEqual(1);
        const left = await prisma.webhookOutboxFanout.findMany({
          where: { outboxId: { in: [gone, recent, pending] } },
        });
        expect(left.map((f) => f.outboxId).sort()).toEqual(
          [recent, pending].sort()
        );
        await prisma.webhookOutboxFanout.deleteMany({
          where: { outboxId: { in: [recent, pending] } },
        });
      });
    });
  });
});
