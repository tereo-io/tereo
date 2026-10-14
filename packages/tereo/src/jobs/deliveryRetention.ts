import { ensureDailyPartitions } from "../utils/partitions.js";
import { getDeliveryRetentionQueue } from "./webhookQueues.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Worker } from "bullmq";

const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RETENTION_DAYS = 90;
const FUTURE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let worker: Worker | null = null;

/**
 * Parse a partition name like "webhook_deliveries_2026_02_23" into a UTC Date.
 * Returns null if parsing fails.
 */
function parsePartitionDate(name: string): Date | null {
  const match = name.match(/^webhook_deliveries_(\d{4})_(\d{2})_(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Create partitions for upcoming days, then drop those older than the
 * retention window. Creating comes first, and each drop stands alone, so a
 * failing drop never leaves the coming days without partitions.
 */
async function processDeliveryRetention(): Promise<void> {
  const now = new Date();
  // UTC throughout: partition bounds are written as UTC dates, so names must
  // be too, or a non-UTC host creates partitions offset from their names.
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const cutoff = new Date(today.getTime() - RETENTION_DAYS * MS_PER_DAY);

  const created = await ensureDailyPartitions(
    "webhooks",
    0,
    FUTURE_DAYS,
    today
  );

  const partitions = await db.webhookDeliveries.listPartitions();
  let dropped = 0;
  let failed = 0;
  for (const { child } of partitions) {
    const partDate = parsePartitionDate(child);
    if (!partDate) continue;

    // The partition covers [partDate, partDate+1day).
    // Drop if the partition's date is before the cutoff.
    if (partDate < cutoff) {
      logger.info({ partition: child }, "Dropping old delivery partition");
      try {
        if (await db.webhookDeliveries.dropPartition(child)) {
          dropped++;
        } else {
          failed++;
          logger.warn(
            { partition: child },
            "Deliveries table locked; dropping the partition next run"
          );
        }
      } catch (err) {
        failed++;
        logger.error(
          { err, partition: child },
          "Failed to drop delivery partition"
        );
      }
    }
  }

  logger.info(
    {
      existingPartitions: partitions.length,
      dropped,
      failed,
      created,
      cutoff: formatDateStr(cutoff),
    },
    "Delivery retention job completed"
  );
}

export async function startDeliveryRetentionWorker(): Promise<void> {
  const redis = getRedisClient();

  worker = new TrackedWorker(
    "webhooks-delivery-retention",
    async () => {
      await processDeliveryRetention();
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Delivery retention job failed"
    );
  });

  const queue = getDeliveryRetentionQueue();
  await queue.upsertJobScheduler(
    "delivery-retention-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "delivery-retention" }
  );

  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
      retentionDays: RETENTION_DAYS,
    },
    "Delivery retention worker started"
  );
}

export async function stopDeliveryRetentionWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { processDeliveryRetention };
