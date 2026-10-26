// @module-tag int
// @module-tag notifications
import type { DeliveryRef } from "../../../utils/db/notifications.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import type { Prisma } from "../../../utils/db/prisma.js";
import { prisma } from "../../../utils/db/prisma.js";
import { waitFor } from "../../support/webhooks.js";
import db from "../../../utils/db/index.js";
import {
  ensureDailyPartitions,
  partitionName,
} from "../../../utils/partitions.js";

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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ymd = (d: Date) => d.toISOString().split("T")[0].replaceAll("-", "_");

const partitionsOf = async (
  table: "notifications" | "notificationDeliveries"
) => (await db.notifications.listPartitions(table)).map((p) => p.child);

describe("db.notifications", () => {
  describe("notification roll-up", { tags: ["race"] }, () => {
    it("is sent, with content dropped, when two deliveries are sent at once", async () => {
      const { notification, deliveries } = await twoDeliveries();
      await settleConcurrently(
        notification,
        [sent, sent],
        deliveries.map(refOf)
      );

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

  describe("notification partitions", () => {
    // Far enough ahead that no retention job or other suite touches it.
    const farDay = new Date(Date.UTC(2099, 5, 1));
    const farDays = [0, 1, 2].map(
      (i) => new Date(farDay.getTime() + i * MS_PER_DAY)
    );
    const createdIds: string[] = [];

    // Deliveries first: their foreign key references the notifications partition.
    const dropFar = async () => {
      for (const day of farDays) {
        await db.notifications.dropPartition(
          "notificationDeliveries",
          partitionName("notificationDeliveries", day)
        );
        await db.notifications.dropPartition(
          "notifications",
          partitionName("notifications", day)
        );
      }
    };

    afterAll(async () => {
      await dropFar();
      await prisma.$executeRawUnsafe(
        `DELETE FROM "notifications"."deliveries" WHERE "notification_id" = ANY($1::uuid[])`,
        createdIds
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM "notifications"."notifications" WHERE "id" = ANY($1::uuid[])`,
        createdIds
      );
    });

    it("creates the day's and the next day's partitions of both tables", async () => {
      await dropFar();
      await ensureDailyPartitions("notifications", 0, 1, farDay);
      await ensureDailyPartitions("notificationDeliveries", 0, 1, farDay);

      const notifications = await partitionsOf("notifications");
      const deliveries = await partitionsOf("notificationDeliveries");
      const [day, next, after] = farDays;
      for (const d of [day, next]) {
        expect(notifications).toContain(`notifications_${ymd(d)}`);
        expect(deliveries).toContain(`deliveries_${ymd(d)}`);
      }
      expect(notifications).not.toContain(`notifications_${ymd(after)}`);
      expect(deliveries).not.toContain(`deliveries_${ymd(after)}`);
    });

    it("accepts a notification and its delivery for today", async () => {
      await ensureDailyPartitions("notifications", 0, 1);
      await ensureDailyPartitions("notificationDeliveries", 0, 1);

      const [n] = await prisma.$queryRaw<{ id: string; created_at: Date }[]>`
      INSERT INTO "notifications"."notifications"
        ("id", "channel", "sender_user_id", "recipients", "attachments", "status", "created_at", "updated_at")
      VALUES (gen_random_uuid(), 'email', ${SYSTEM_USER_ID}::uuid, '[]'::jsonb, '[]'::jsonb, 'pending', now(), now())
      RETURNING "id"::text, "created_at"`;
      createdIds.push(n.id);

      const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "notifications"."deliveries"
        ("id", "notification_id", "notification_created_at", "recipients", "status", "attempts", "created_at", "updated_at")
      VALUES (gen_random_uuid(), ${n.id}::uuid, ${n.created_at}, '[]'::jsonb, 'pending', 0, now(), now())
      RETURNING "id"::text`;
      expect(rows).toHaveLength(1);
    });

    it("rejects a delivery that matches no notification", async () => {
      await expect(
        prisma.$executeRaw`
        INSERT INTO "notifications"."deliveries"
          ("id", "notification_id", "notification_created_at", "recipients", "status", "attempts", "created_at", "updated_at")
        VALUES (gen_random_uuid(), gen_random_uuid(), now(), '[]'::jsonb, 'pending', 0, now(), now())`
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  describe("dropping a day's partitions", () => {
    const day = new Date(Date.UTC(2099, 2, 1));
    const next = new Date(day.getTime() + MS_PER_DAY);

    it("drops the deliveries partition, then the notifications partition", async () => {
      const stamp = "2099-03-01T12:00:00Z";
      await ensureDailyPartitions("notifications", 0, 0, day);
      await ensureDailyPartitions("notificationDeliveries", 0, 0, day);

      const [n] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "notifications"."notifications"
        ("id", "channel", "sender_user_id", "recipients", "attachments", "status", "created_at", "updated_at")
      VALUES (gen_random_uuid(), 'email', ${SYSTEM_USER_ID}::uuid, '[]'::jsonb, '[]'::jsonb, 'pending', ${stamp}::timestamp, now())
      RETURNING "id"::text`;
      await prisma.$executeRaw`
      INSERT INTO "notifications"."deliveries"
        ("id", "notification_id", "notification_created_at", "recipients", "status", "attempts", "created_at", "updated_at")
      VALUES (gen_random_uuid(), ${n.id}::uuid, ${stamp}::timestamp, '[]'::jsonb, 'pending', 0, now(), now())`;

      await db.notifications.dropPartition(
        "notificationDeliveries",
        partitionName("notificationDeliveries", day)
      );
      await db.notifications.dropPartition(
        "notifications",
        partitionName("notifications", day)
      );

      const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM "notifications"."notifications" WHERE "id" = ${n.id}::uuid`;
      expect(count).toBe(0n);
      expect(await partitionsOf("notifications")).not.toContain(
        `notifications_${ymd(day)}`
      );
      expect(next.getTime()).toBeGreaterThan(day.getTime());
    });
  });
});
