// @module-tag int
// @module-tag notifications
// @module-tag platform
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import {
  ensureDailyPartitions,
  partitionName,
} from "../../../utils/partitions.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ymd = (d: Date) => d.toISOString().split("T")[0].replaceAll("-", "_");

const partitionsOf = async (
  table: "notifications" | "notificationDeliveries"
) => (await db.notifications.listPartitions(table)).map((p) => p.child);

describe("db.notifications partitions", () => {
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
