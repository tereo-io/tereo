// @module-tag int
// @module-tag platform
// @module-tag race
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import env from "../../env.js";
import { Client } from "pg";
import {
  ensureCurrentPartitions,
  ensureDailyPartitions,
  partitionName,
  utcDay,
} from "../../utils/partitions.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Far enough ahead that no retention job or other suite touches it.
const FAR_DAY = new Date(Date.UTC(2099, 0, 1));

const FAR_NEXT = new Date(FAR_DAY.getTime() + MS_PER_DAY);

const children = (rows: { child: string }[]) => rows.map((p) => p.child);

const names = async () => ({
  audit: children(await db.auditLogEntries.listPartitions()),
  webhooks: children(await db.webhookDeliveries.listPartitions()),
  notifications: children(
    await db.notifications.listPartitions("notifications")
  ),
  deliveries: children(
    await db.notifications.listPartitions("notificationDeliveries")
  ),
});

const dropFar = async () => {
  for (const day of [FAR_DAY, FAR_NEXT]) {
    await db.auditLogEntries.dropPartition(partitionName("audit", day));
    await db.webhookDeliveries.dropPartition(partitionName("webhooks", day));
    // Deliveries first: their foreign key references the notifications partition.
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

// A read holding ACCESS SHARE on the parent until released.
const holdParent = async (table: string) => {
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  await holder.query("BEGIN");
  await holder.query(`LOCK TABLE ${table} IN ACCESS SHARE MODE`);
  return async () => {
    await holder.query("ROLLBACK");
    await holder.end();
  };
};

const WAITING = "still waiting";

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<typeof WAITING>((r) => setTimeout(() => r(WAITING), ms)),
  ]);

describe("ensureCurrentPartitions", () => {
  afterAll(dropFar);

  it("leaves today's and tomorrow's partitions in place after startup", async () => {
    const today = utcDay();
    const tomorrow = new Date(today.getTime() + MS_PER_DAY);
    const { audit, webhooks, notifications, deliveries } = await names();
    for (const day of [today, tomorrow]) {
      expect(audit).toContain(partitionName("audit", day));
      expect(webhooks).toContain(partitionName("webhooks", day));
      expect(notifications).toContain(partitionName("notifications", day));
      expect(deliveries).toContain(
        partitionName("notificationDeliveries", day)
      );
    }
  });

  it("creates the day's and next day's partition of both tables", async () => {
    await dropFar();
    await ensureCurrentPartitions(FAR_DAY);

    const { audit, webhooks, notifications, deliveries } = await names();
    expect(audit).toContain("audit_log_entries_2099_01_01");
    expect(audit).toContain("audit_log_entries_2099_01_02");
    expect(audit).not.toContain("audit_log_entries_2099_01_03");
    expect(webhooks).toContain("webhook_deliveries_2099_01_01");
    expect(webhooks).toContain("webhook_deliveries_2099_01_02");
    expect(notifications).toContain("notifications_2099_01_01");
    expect(notifications).toContain("notifications_2099_01_02");
    expect(deliveries).toContain("deliveries_2099_01_01");
    expect(deliveries).toContain("deliveries_2099_01_02");
    expect(deliveries).not.toContain("deliveries_2099_01_03");
  });

  it("is idempotent", async () => {
    await ensureCurrentPartitions(FAR_DAY);
    const before = await names();
    await expect(ensureCurrentPartitions(FAR_DAY)).resolves.toBeUndefined();
    const after = await names();
    const far = (list: string[]) => list.filter((n) => n.includes("_2099_"));
    expect(far(after.audit)).toEqual(far(before.audit));
    expect(far(after.webhooks)).toEqual(far(before.webhooks));
    expect(far(after.notifications)).toEqual(far(before.notifications));
    expect(far(after.deliveries)).toEqual(far(before.deliveries));
    expect(far(after.audit)).toHaveLength(2);
  });

  it("survives processes starting at once", async () => {
    await dropFar();
    await Promise.all(
      Array.from({ length: 8 }, () => ensureCurrentPartitions(FAR_DAY))
    );

    const { audit, webhooks, notifications, deliveries } = await names();
    expect(audit).toContain("audit_log_entries_2099_01_01");
    expect(audit).toContain("audit_log_entries_2099_01_02");
    expect(webhooks).toContain("webhook_deliveries_2099_01_01");
    expect(webhooks).toContain("webhook_deliveries_2099_01_02");
    expect(notifications).toContain("notifications_2099_01_02");
    expect(deliveries).toContain("deliveries_2099_01_02");
  });
});

describe("ensureDailyPartitions", () => {
  describe("creating a partition while its parent is in use", () => {
    afterAll(dropFar);

    const cases = [
      {
        table: "audit" as const,
        parent: '"audit"."audit_log_entries"',
      },
      {
        table: "webhooks" as const,
        parent: '"webhooks"."webhook_deliveries"',
      },
      {
        table: "notificationDeliveries" as const,
        parent: '"notifications"."deliveries"',
      },
    ];

    it.each(cases)(
      "gives up on $parent instead of queueing, and creates it once free",
      async ({ table, parent }) => {
        await dropFar();
        await ensureCurrentPartitions(FAR_DAY);
        await db.notifications.dropPartition(
          "notificationDeliveries",
          partitionName("notificationDeliveries", FAR_DAY)
        );
        await db.auditLogEntries.dropPartition(partitionName("audit", FAR_DAY));
        await db.webhookDeliveries.dropPartition(
          partitionName("webhooks", FAR_DAY)
        );
        const name = partitionName(table, FAR_DAY);

        const release = await holdParent(parent);
        let pending: Promise<number> | undefined;
        try {
          pending = ensureDailyPartitions(table, 0, 0, FAR_DAY);
          await expect(within(pending, 10_000)).resolves.toBe(0);
        } finally {
          await release();
          await pending;
        }
        expect(Object.values(await names()).flat()).not.toContain(name);

        await expect(ensureDailyPartitions(table, 0, 0, FAR_DAY)).resolves.toBe(
          1
        );
        expect(Object.values(await names()).flat()).toContain(name);
      },
      30_000
    );

    it("does not wait on a partition that already exists", async () => {
      await ensureCurrentPartitions(FAR_DAY);
      const release = await holdParent('"audit"."audit_log_entries"');
      try {
        await expect(
          within(ensureDailyPartitions("audit", 0, 1, FAR_DAY), 2_000)
        ).resolves.toBe(2);
      } finally {
        await release();
      }
    });

    it("retries on start until a lock held past one timeout is released", async () => {
      await dropFar();
      const release = await holdParent('"audit"."audit_log_entries"');
      // Past the first attempt's timeout, well before the last one's.
      const releasing = new Promise((r) =>
        setTimeout(r, env.PARTITION_DDL_LOCK_TIMEOUT_MS * 1.4)
      ).then(release);
      try {
        await ensureCurrentPartitions(FAR_DAY);
      } finally {
        await releasing;
      }
      const { audit } = await names();
      expect(audit).toContain(partitionName("audit", FAR_DAY));
      expect(audit).toContain(partitionName("audit", FAR_NEXT));
    }, 30_000);
  });
});

describe("dropPartition", () => {
  describe("dropping a partition while its parent is in use", () => {
    afterAll(dropFar);

    const cases = [
      {
        parent: '"audit"."audit_log_entries"',
        name: partitionName("audit", FAR_DAY),
        drop: (name: string) => db.auditLogEntries.dropPartition(name),
      },
      {
        parent: '"webhooks"."webhook_deliveries"',
        name: partitionName("webhooks", FAR_DAY),
        drop: (name: string) => db.webhookDeliveries.dropPartition(name),
      },
      {
        parent: '"notifications"."deliveries"',
        name: partitionName("notificationDeliveries", FAR_DAY),
        drop: (name: string) =>
          db.notifications.dropPartition("notificationDeliveries", name),
      },
    ];

    it.each(cases)(
      "gives up on $parent instead of queueing, and drops it once free",
      async ({ parent, name, drop }) => {
        await ensureCurrentPartitions(FAR_DAY);
        const release = await holdParent(parent);
        try {
          await expect(drop(name)).resolves.toBe(false);
        } finally {
          await release();
        }
        const all = Object.values(await names()).flat();
        expect(all).toContain(name);

        await expect(drop(name)).resolves.toBe(true);
        expect(Object.values(await names()).flat()).not.toContain(name);
      },
      20_000
    );

    // Dropping a deliveries partition also locks the notifications table its
    // foreign key references, after the deliveries parent; a writer locking the
    // two the other way round deadlocks with it.
    it("gives up on a deadlock instead of failing, and drops it once free", async () => {
      await ensureCurrentPartitions(FAR_DAY);
      const name = partitionName("notificationDeliveries", FAR_DAY);
      const writer = new Client({ connectionString: process.env.DATABASE_URL });
      await writer.connect();
      let writing: Promise<unknown> | undefined;
      try {
        await writer.query("BEGIN");
        // Postgres fails the session whose deadlock check runs first. Had the
        // drop queued behind another session's lock on the deliveries parent,
        // its wait for notifications starts after the writer's; checking only
        // well past the drop's lock timeout, the writer is never the one failed.
        await writer.query(
          `SET LOCAL deadlock_timeout = ${env.PARTITION_DDL_LOCK_TIMEOUT_MS * 5}`
        );
        await writer.query(
          'LOCK TABLE "notifications"."notifications" IN ROW EXCLUSIVE MODE'
        );
        const dropping = db.notifications.dropPartition(
          "notificationDeliveries",
          name
        );
        // Polled outside the writer's transaction, which would keep seeing the
        // same snapshot of pg_stat_activity.
        await expect
          .poll(
            async () =>
              (
                await prisma.$queryRaw<unknown[]>`
                SELECT 1 FROM pg_stat_activity
                WHERE wait_event_type = 'Lock'
                  AND query ILIKE '%' || ${name} || '%'`
              ).length,
            { timeout: 5_000 }
          )
          .toBe(1);
        writing = writer.query(
          'LOCK TABLE "notifications"."deliveries" IN ROW EXCLUSIVE MODE'
        );
        // Handled at once, so a failed lock fails the test at `await writing`
        // rather than as an unhandled rejection while the drop is awaited.
        writing.catch(() => undefined);
        await expect(dropping).resolves.toBe(false);
        await writing;
      } finally {
        await writing?.catch(() => undefined);
        await writer.query("ROLLBACK");
        await writer.end();
      }
      expect(Object.values(await names()).flat()).toContain(name);

      await expect(
        db.notifications.dropPartition("notificationDeliveries", name)
      ).resolves.toBe(true);
      expect(Object.values(await names()).flat()).not.toContain(name);
    }, 20_000);
  });
});
