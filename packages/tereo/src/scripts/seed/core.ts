import { ensureDailyPartitions } from "../../utils/partitions.js";

/**
 * Daily partitions for the partitioned tables, `days` either side of
 * today (UTC). The worker's retention jobs keep creating them after this; the
 * seed makes sure writes work before the worker first runs.
 */
export async function ensurePartitions(days = 7): Promise<void> {
  console.error("Creating partitions...");
  await ensureDailyPartitions("audit", -days, days);
  await ensureDailyPartitions("webhooks", -days, days);
  await ensureDailyPartitions("notifications", -days, days);
  await ensureDailyPartitions("notificationDeliveries", -days, days);
  console.error(`  ${days * 2 + 1} days for audit, webhooks and notifications`);
}
