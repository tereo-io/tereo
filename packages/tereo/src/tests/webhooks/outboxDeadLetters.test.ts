import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runOutboxRetention } from "../../jobs/outboxRetention.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  OutboxReplayUsageError,
  parseOutboxReplayArgs,
  replayOutbox,
} from "../../cli/outboxReplay/index.js";
import {
  cleanupTestEntities,
  createTestWebhookEndpoint,
  getTestAccessToken,
  getTestOrgId,
  waitFor,
} from "./utils/test-helpers.js";

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

describe("outbox dead letters", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await prisma.outbox.deleteMany({
      where: { destination: { startsWith: DESTINATION } },
    });
    await cleanupTestEntities();
  });

  describe("outbox-replay", () => {
    it("returns a dead-lettered webhook row to the reaper, which delivers it", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const id = await insertDeadLetter("webhook", {
        organizationId: getTestOrgId(),
        eventType: ep.eventTypes[0],
        entityType: "TestEntity",
        entityId: crypto.randomUUID(),
        data: { replayed: true },
      });

      const result = await replayOutbox({ ids: [id] });
      expect(result).toEqual({ dryRun: false, replayed: 1 });

      // The server's reaper claims it once it is due again.
      await waitFor(
        async () => (await prisma.outbox.count({ where: { id } })) === 0,
        10_000
      );
      const deliveries = await prisma.webhookDelivery.findMany({
        where: { webhookEndpointId: ep.id },
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].payload).toMatchObject({ data: { replayed: true } });
    });

    it("requires a filter unless --all is given", async () => {
      const id = await insertDeadLetter(DESTINATION, {});

      await expect(replayOutbox({})).rejects.toBeInstanceOf(
        OutboxReplayUsageError
      );
      await expect(replayOutbox({ dryRun: true })).rejects.toBeInstanceOf(
        OutboxReplayUsageError
      );
      expect(() => parseOutboxReplayArgs(["--id", "nope"])).toThrow(
        OutboxReplayUsageError
      );
      expect(() => parseOutboxReplayArgs(["--since", "yesterday"])).toThrow(
        OutboxReplayUsageError
      );
      expect(parseOutboxReplayArgs(["--all", "--dry-run"])).toEqual({
        all: true,
        dryRun: true,
      });

      const row = await prisma.outbox.findUniqueOrThrow({ where: { id } });
      expect(row.deadLetteredAt).not.toBeNull();
    });

    it("counts without changing anything on --dry-run, and filters by destination and time", async () => {
      const destination = `${DESTINATION}-${crypto.randomUUID()}`;
      const old = await insertDeadLetter(
        destination,
        {},
        new Date(Date.now() - 2 * DAY_MS)
      );
      const recent = await insertDeadLetter(destination, {});

      const opts = parseOutboxReplayArgs([
        "--destination",
        destination,
        "--since",
        new Date(Date.now() - DAY_MS).toISOString(),
        "--dry-run",
      ]);
      expect(await replayOutbox(opts)).toEqual({ dryRun: true, replayed: 1 });
      const untouched = await prisma.outbox.findUniqueOrThrow({
        where: { id: recent },
      });
      expect(untouched.deadLetteredAt).not.toBeNull();

      // Due again, the server's reaper would dead-letter a row with no
      // dispatcher at once; checked through the returned count instead.
      expect(
        await replayOutbox({ ...opts, dryRun: false, ids: [old] })
      ).toEqual({ dryRun: false, replayed: 0 });
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
