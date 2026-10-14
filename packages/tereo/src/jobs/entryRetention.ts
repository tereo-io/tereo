import { ensureDailyPartitions } from "../utils/partitions.js";
import { getEntryRetentionQueue } from "./auditQueues.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Worker } from "bullmq";
import env from "../env.js";

const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FUTURE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse a partition name like "audit_log_entries_2026_02_23" into a UTC Date.
 * Returns null if parsing fails.
 */
function parsePartitionDate(name: string): Date | null {
  const match = name.match(/^audit_log_entries_(\d{4})_(\d{2})_(\d{2})$/);
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
async function processEntryRetention(): Promise<void> {
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const retentionDays = env.AUDIT_RETENTION_DAYS;
  const cutoff = new Date(today.getTime() - retentionDays * MS_PER_DAY);

  const created = await ensureDailyPartitions("audit", 0, FUTURE_DAYS, today);

  const partitions = await db.auditLogEntries.listPartitions();
  let dropped = 0;
  let failed = 0;
  for (const { child } of partitions) {
    const partDate = parsePartitionDate(child);
    if (!partDate) continue;

    // The partition covers [partDate, partDate+1day).
    // Drop if the partition's date is before the cutoff.
    if (partDate < cutoff) {
      logger.info({ partition: child }, "Dropping old audit log partition");
      try {
        if (await db.auditLogEntries.dropPartition(child)) {
          dropped++;
        } else {
          failed++;
          logger.warn(
            { partition: child },
            "Audit log table locked; dropping the partition next run"
          );
        }
      } catch (err) {
        failed++;
        logger.error(
          { err, partition: child },
          "Failed to drop audit log partition"
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
    "Entry retention job completed"
  );
}

let worker: Worker | null = null;

export async function startEntryRetentionWorker(): Promise<void> {
  const redis = getRedisClient();

  worker = new TrackedWorker(
    "audit-entry-retention",
    async () => {
      await processEntryRetention();
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Entry retention job failed"
    );
  });

  const queue = getEntryRetentionQueue();
  await queue.upsertJobScheduler(
    "entry-retention-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "entry-retention" }
  );

  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
      retentionDays: env.AUDIT_RETENTION_DAYS,
    },
    "Entry retention worker started"
  );
}

export async function stopEntryRetentionWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { processEntryRetention };
