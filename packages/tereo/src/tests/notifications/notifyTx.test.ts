import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { waitFor } from "../webhooks/utils/test-helpers.js";
import { prisma } from "../../utils/db/prisma.js";
import { notifyTx } from "../../utils/outbox.js";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../jobs/notificationQueues.js";

const input = {
  channel: "email" as const,
  recipients: [{ address: "ops@example.com" }],
  content: { subject: "Core says hello", text: "Hello" },
};

const outboxRows = (id: string) =>
  prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "core"."outbox"
    WHERE destination = 'notification' AND payload->>'notificationId' = ${id}`;

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

describe("notifyTx", () => {
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
