import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DeliveryRef } from "../../utils/db/notifications.js";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { waitFor } from "../webhooks/utils/test-helpers.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import type { Prisma } from "../../utils/db/prisma.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";

type Tx = Prisma.TransactionClient;

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
});

/** A notification with two deliveries, both mid-send. No outbox row. */
const twoDeliveries = async () => {
  const notification = await prisma.$transaction((tx) =>
    db.notifications.insert(
      tx,
      {
        channel: "email",
        senderUserId: SYSTEM_USER_ID,
        recipients: [
          { address: "a@example.com" },
          { address: "b@example.com" },
        ],
        content: { subject: "Hi", text: "x" },
        attachments: [],
      },
      ["a@example.com", "b@example.com"].map((address) => ({
        recipients: [{ address, as: "to" }],
        status: "sending" as const,
        attempts: 1,
      }))
    )
  );
  created.push(notification.id);
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { notificationId: notification.id },
  });
  return { notification, deliveries };
};

/** Whether a backend is waiting on a row lock in the notifications schema. */
const lockWaiting = async () => {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_stat_activity
    WHERE datname = current_database()
      AND wait_event_type = 'Lock'
      AND query ILIKE '%notifications%'`;
  return rows[0].n > 0n;
};

/**
 * Settle both deliveries in two transactions that overlap: each marks its
 * delivery, waits until both have, rolls up, and then holds its commit until
 * the other has rolled up too or is blocked on a lock. Without a lock on the
 * notification, each roll-up reads the other delivery still `sending`.
 */
const settleConcurrently = async (
  notification: { id: string; createdAt: Date },
  settles: ((tx: Tx, ref: DeliveryRef) => Promise<unknown>)[],
  refs: DeliveryRef[]
) => {
  let marked = 0;
  let rolledUp = 0;
  await Promise.all(
    settles.map((settle, i) =>
      prisma.$transaction(
        async (tx) => {
          await settle(tx, refs[i]);
          marked++;
          await waitFor(async () => marked === 2, 10_000, 10);
          await db.notifications.rollUp(
            tx,
            notification.id,
            notification.createdAt
          );
          rolledUp++;
          await waitFor(
            async () => rolledUp === 2 || (await lockWaiting()),
            10_000,
            10
          );
        },
        { timeout: 30_000 }
      )
    )
  );
};

const refOf = (d: { id: string; notificationCreatedAt: Date }) => ({
  id: d.id,
  notificationCreatedAt: d.notificationCreatedAt,
});

const sent = (tx: Tx, ref: DeliveryRef) =>
  db.notifications.markSent(tx, ref, {
    providerMessageId: "<x@example.com>",
    providerResponse: "250 OK",
  });

describe("notification roll-up", () => {
  it("is sent, with content dropped, when two deliveries are sent at once", async () => {
    const { notification, deliveries } = await twoDeliveries();
    await settleConcurrently(notification, [sent, sent], deliveries.map(refOf));

    const row = await prisma.notification.findFirstOrThrow({
      where: { id: notification.id },
    });
    expect(row.status).toBe("sent");
    expect(row.content).toBeNull();
  });

  it("is partial when one is sent and one fails at once", async () => {
    const { notification, deliveries } = await twoDeliveries();
    await settleConcurrently(
      notification,
      [sent, (tx, ref) => db.notifications.markFailed(tx, ref, "550 no")],
      deliveries.map(refOf)
    );

    const row = await prisma.notification.findFirstOrThrow({
      where: { id: notification.id },
    });
    expect(row.status).toBe("partial");
    expect(row.content).not.toBeNull();
  });
});
