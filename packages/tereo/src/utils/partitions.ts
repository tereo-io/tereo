import { pgErrorCodes } from "./prismaErrors.js";
import { logger } from "./logger.js";
import db from "./db/index.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PartitionedTable =
  "audit" | "webhooks" | "notifications" | "notificationDeliveries";

const TABLES: Record<
  PartitionedTable,
  {
    prefix: string;
    create: (name: string, from: string, to: string) => Promise<boolean>;
  }
> = {
  audit: {
    prefix: "audit_log_entries",
    create: db.auditLogEntries.createPartition,
  },
  webhooks: {
    prefix: "webhook_deliveries",
    create: db.webhookDeliveries.createPartition,
  },
  notifications: {
    prefix: "notifications",
    create: db.notifications.createNotificationsPartition,
  },
  notificationDeliveries: {
    prefix: "deliveries",
    create: db.notifications.createDeliveriesPartition,
  },
};

/** Midnight UTC of `now`'s day. Partition bounds and names are UTC dates. */
export const utcDay = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const dateStr = (d: Date) => d.toISOString().split("T")[0];

export const partitionName = (table: PartitionedTable, day: Date): string =>
  `${TABLES[table].prefix}_${dateStr(day).replaceAll("-", "_")}`;

/**
 * Two processes creating the same partition at once can both pass `IF NOT
 * EXISTS`; the loser then fails on the catalog's unique index — 23505 on
 * `pg_type`, or 42P07 when the relation is already visible.
 */
const isConcurrentCreate = (err: unknown): boolean => {
  const codes = pgErrorCodes(err);
  if (codes.includes("42P07") || codes.includes("23505")) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|pg_type_typname_nsp_index/.test(message);
};

/**
 * Daily partitions of `table` for the days `firstDay` through `lastDay`
 * relative to `today` (UTC; 0 is today), in order. Idempotent, and safe to
 * run from several processes at once. Stops at the first day whose parent
 * stayed locked and returns how many days were ensured before it.
 */
export async function ensureDailyPartitions(
  table: PartitionedTable,
  firstDay: number,
  lastDay: number,
  today: Date = utcDay()
): Promise<number> {
  const start = utcDay(today);
  let ensured = 0;
  for (let i = firstDay; i <= lastDay; i++) {
    const day = new Date(start.getTime() + i * MS_PER_DAY);
    const next = new Date(day.getTime() + MS_PER_DAY);
    const name = partitionName(table, day);
    let created: boolean;
    try {
      created = await TABLES[table].create(name, dateStr(day), dateStr(next));
    } catch (err) {
      if (!isConcurrentCreate(err)) throw err;
      logger.debug({ partition: name }, "Partition created concurrently");
      created = true;
    }
    if (!created) {
      // The later days would only wait out the same lock.
      logger.warn(
        { partition: name },
        "Partitioned table locked; creating the partition next run"
      );
      break;
    }
    ensured++;
  }
  return ensured;
}

// Each attempt waits out runPartitionDdl's lock timeout before giving up.
const STARTUP_ATTEMPTS = 3;

/**
 * Today's and tomorrow's partitions of every partitioned table, so audited
 * writes, webhook deliveries and notifications keep working while the worker, which creates
 * them a week ahead, is down.
 */
export async function ensureCurrentPartitions(
  today: Date = utcDay()
): Promise<void> {
  const day = utcDay(today);
  const tomorrow = new Date(day.getTime() + MS_PER_DAY);
  for (const table of Object.keys(TABLES) as PartitionedTable[]) {
    let ensured = 0;
    for (let i = 0; i < STARTUP_ATTEMPTS && ensured < 2; i++) {
      ensured = await ensureDailyPartitions(table, 0, 1, day);
    }
    if (ensured === 0) {
      logger.error(
        { partition: partitionName(table, day) },
        "Today's partition is missing and its table stayed locked; writes to it fail until a retention run creates it"
      );
    } else if (ensured === 1) {
      logger.warn(
        { partition: partitionName(table, tomorrow) },
        "Tomorrow's partition is missing and its table stayed locked; a retention run creates it"
      );
    }
  }
}
