import { ensureDailyPartitions, utcDay } from "../utils/partitions.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import { Queue, Worker } from "bullmq";
import db from "../utils/db/index.js";
import {
  createQueue,
  REMOVAL_POLICIES,
  RETRY_POLICIES,
} from "../utils/bullmq.js";

const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;
const FUTURE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;

const PARTITION_DAY = /_(\d{4})_(\d{2})_(\d{2})$/;

const partitionDay = (name: string): Date | null => {
  const match = name.match(PARTITION_DAY);
  if (!match) return null;
  return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
};

/**
 * Creates the coming days' notification partitions, then drops those older
 * than the retention window, and any detached ones a crashed drop left
 * behind. Creating comes first, and each drop stands alone, so a failing drop
 * never leaves the coming days without partitions. A day's deliveries
 * partition goes before its notifications partition, which the deliveries
 * foreign key references; a notifications partition whose deliveries
 * partition stayed is kept too. `notBefore` leaves older partitions alone;
 * tests that pick their own `now` use it to avoid dropping the real ones.
 */
export async function runNotificationRetention(
  now: Date = new Date(),
  { notBefore }: { notBefore?: Date } = {}
): Promise<{ dropped: string[]; failed: string[] }> {
  const today = utcDay(now);
  const cutoff = new Date(today.getTime() - RETENTION_DAYS * MS_PER_DAY);
  const dropped: string[] = [];
  const failed: string[] = [];
  const keptDays = new Set<number>();

  await ensureDailyPartitions("notifications", 0, FUTURE_DAYS, today);
  await ensureDailyPartitions("notificationDeliveries", 0, FUTURE_DAYS, today);

  for (const table of ["notificationDeliveries", "notifications"] as const) {
    const candidates = [
      ...(await db.notifications.listPartitions(table)),
      ...(await db.notifications.listDetachedPartitions(table)),
    ];
    for (const { child } of candidates) {
      const day = partitionDay(child);
      if (!day || day >= cutoff) continue;
      if (notBefore && day < notBefore) continue;
      if (table === "notifications" && keptDays.has(day.getTime())) continue;
      logger.info({ partition: child }, "Dropping old notification partition");
      try {
        if (await db.notifications.dropPartition(table, child)) {
          dropped.push(child);
          continue;
        }
        logger.warn(
          { partition: child },
          "Notification table locked; dropping the partition next run"
        );
      } catch (err) {
        logger.error(
          { err, partition: child },
          "Failed to drop notification partition"
        );
      }
      failed.push(child);
      keptDays.add(day.getTime());
    }
  }

  logger.info(
    {
      dropped: dropped.length,
      failed: failed.length,
      cutoff: cutoff.toISOString().split("T")[0],
    },
    "Notification retention job completed"
  );
  return { dropped, failed };
}

export async function startNotificationRetentionWorker(): Promise<void> {
  worker = new TrackedWorker(
    "notifications-retention",
    async () => {
      await runNotificationRetention();
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Notification retention job failed");
  });

  queue = createQueue("notifications-retention", {
    defaultJobOptions: {
      ...RETRY_POLICIES.ONESHOT,
      ...REMOVAL_POLICIES.MAINTENANCE,
    },
  });
  await queue.upsertJobScheduler(
    "notification-retention-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "notification-retention" }
  );

  logger.info(
    { intervalMs: JOB_INTERVAL_MS, retentionDays: RETENTION_DAYS },
    "Notification retention worker started"
  );
}

export async function stopNotificationRetentionWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
