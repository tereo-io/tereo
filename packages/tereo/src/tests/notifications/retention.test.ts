import { runNotificationRetention } from "../../jobs/notificationRetention.js";
import { ensurePartitions } from "../../scripts/seed/core.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import {
  ensureDailyPartitions,
  partitionName,
} from "../../utils/partitions.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const names = async (table: "notifications" | "notificationDeliveries") =>
  (await db.notifications.listPartitions(table)).map((p) => p.child);

describe("notification retention", () => {
  // `notBefore` keeps the job from dropping real partitions, which are all
  // older than this far-future "today" minus 30 days.
  const now = new Date(Date.UTC(2098, 5, 15, 3, 0, 0));
  const dayAt = (offset: number) =>
    new Date(now.getTime() + offset * MS_PER_DAY);

  it("drops partitions older than 30 days, deliveries first, and creates 7 days ahead", async () => {
    for (const offset of [-31, -29]) {
      await ensureDailyPartitions("notifications", offset, offset, now);
      await ensureDailyPartitions(
        "notificationDeliveries",
        offset,
        offset,
        now
      );
    }

    const { dropped } = await runNotificationRetention(now, {
      notBefore: dayAt(-40),
    });

    const old = partitionName("notifications", dayAt(-31));
    const oldDeliveries = partitionName("notificationDeliveries", dayAt(-31));
    expect(dropped).toContain(old);
    expect(dropped).toContain(oldDeliveries);
    expect(dropped.indexOf(oldDeliveries)).toBeLessThan(dropped.indexOf(old));

    const notifications = await names("notifications");
    const deliveries = await names("notificationDeliveries");
    expect(notifications).not.toContain(old);
    expect(deliveries).not.toContain(oldDeliveries);
    expect(notifications).toContain(partitionName("notifications", dayAt(-29)));
    expect(deliveries).toContain(
      partitionName("notificationDeliveries", dayAt(-29))
    );
    for (let i = 0; i <= 7; i++) {
      expect(notifications).toContain(partitionName("notifications", dayAt(i)));
      expect(deliveries).toContain(
        partitionName("notificationDeliveries", dayAt(i))
      );
    }
  });
});

describe("notification retention, partial failures", () => {
  const now = new Date(Date.UTC(2097, 2, 10, 3, 0, 0));
  const dayAt = (offset: number) =>
    new Date(now.getTime() + offset * MS_PER_DAY);
  const run = () => runNotificationRetention(now, { notBefore: dayAt(-40) });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the coming days and drops the other days when one drop fails", async () => {
    for (const offset of [-33, -32]) {
      await ensureDailyPartitions("notifications", offset, offset, now);
      await ensureDailyPartitions(
        "notificationDeliveries",
        offset,
        offset,
        now
      );
    }
    const failing = partitionName("notificationDeliveries", dayAt(-33));
    const drop = db.notifications.dropPartition;
    vi.spyOn(db.notifications, "dropPartition").mockImplementation(
      async (table, name) => {
        if (name === failing) throw new Error("drop failed");
        return drop(table, name);
      }
    );

    const { dropped, failed } = await run();

    expect(failed).toEqual([failing]);
    // Its notifications partition stays: the deliveries foreign key needs it.
    expect(dropped).not.toContain(partitionName("notifications", dayAt(-33)));
    expect(dropped).toContain(
      partitionName("notificationDeliveries", dayAt(-32))
    );
    expect(dropped).toContain(partitionName("notifications", dayAt(-32)));
    for (let i = 0; i <= 7; i++) {
      expect(await names("notifications")).toContain(
        partitionName("notifications", dayAt(i))
      );
    }

    vi.restoreAllMocks();
    expect((await run()).dropped).toEqual([
      failing,
      partitionName("notifications", dayAt(-33)),
    ]);
  });

  it("drops a partition a crashed drop detached but never dropped", async () => {
    await ensureDailyPartitions("notificationDeliveries", -34, -34, now);
    const stray = partitionName("notificationDeliveries", dayAt(-34));
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "notifications"."deliveries" DETACH PARTITION "notifications"."${stray}"`
    );

    expect((await run()).dropped).toContain(stray);
    const left = await prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'notifications' AND c.relname = ${stray}`;
    expect(left).toHaveLength(0);
  });
});

describe("seed partitions", () => {
  it("creates notification partitions either side of today", async () => {
    await ensurePartitions(2);
    const today = new Date();
    for (const offset of [-2, 0, 2]) {
      const day = new Date(today.getTime() + offset * MS_PER_DAY);
      expect(await names("notifications")).toContain(
        partitionName("notifications", day)
      );
      expect(await names("notificationDeliveries")).toContain(
        partitionName("notificationDeliveries", day)
      );
    }
  });
});
