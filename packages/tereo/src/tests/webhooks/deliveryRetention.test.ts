import { processDeliveryRetention } from "../../jobs/deliveryRetention.js";
import { describe, it, expect, afterAll } from "vitest";
import db from "../../utils/db/index.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatPartitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `webhook_deliveries_${year}_${month}_${day}`;
}

// Partitions are named and bounded by UTC day, as the job creates them.
function todayUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

function formatDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

async function getPartitionNames(): Promise<string[]> {
  const partitions = await db.webhookDeliveries.listPartitions();
  return partitions.map((p) => p.child);
}

describe("Delivery Retention", () => {
  // Track partitions we create so we can clean up
  const createdPartitions: string[] = [];

  afterAll(async () => {
    // Clean up any test partitions that shouldn't exist
    for (const name of createdPartitions) {
      await db.webhookDeliveries.dropPartition(name).catch(() => {});
    }
  });

  describe("listPartitions", () => {
    it("should list existing partitions", async () => {
      const partitions = await db.webhookDeliveries.listPartitions();

      expect(Array.isArray(partitions)).toBe(true);
      expect(partitions.length).toBeGreaterThan(0);

      for (const p of partitions) {
        expect(p.child).toMatch(/^webhook_deliveries_\d{4}_\d{2}_\d{2}$/);
      }
    });
  });

  describe("createPartition / dropPartition", () => {
    it("should create a new partition and drop it", async () => {
      // Create a partition far in the future to avoid conflicts
      const futureDate = new Date(2099, 0, 1);
      const nextDay = new Date(2099, 0, 2);
      const name = formatPartitionName(futureDate);
      createdPartitions.push(name);

      await db.webhookDeliveries.createPartition(
        name,
        formatDateStr(futureDate),
        formatDateStr(nextDay)
      );

      let partitions = await getPartitionNames();
      expect(partitions).toContain(name);

      // Drop it
      await db.webhookDeliveries.dropPartition(name);

      partitions = await getPartitionNames();
      expect(partitions).not.toContain(name);
    });

    it("should be idempotent with CREATE TABLE IF NOT EXISTS", async () => {
      const futureDate = new Date(2099, 5, 15);
      const nextDay = new Date(2099, 5, 16);
      const name = formatPartitionName(futureDate);
      createdPartitions.push(name);

      await db.webhookDeliveries.createPartition(
        name,
        formatDateStr(futureDate),
        formatDateStr(nextDay)
      );

      // Create again — should not throw
      await db.webhookDeliveries.createPartition(
        name,
        formatDateStr(futureDate),
        formatDateStr(nextDay)
      );

      const partitions = await getPartitionNames();
      expect(partitions.filter((p) => p === name).length).toBe(1);

      await db.webhookDeliveries.dropPartition(name);
    });
  });

  describe("processDeliveryRetention", () => {
    it("should ensure today's partition and future partitions exist", async () => {
      await processDeliveryRetention();

      const today = todayUTC();
      const partitions = await getPartitionNames();

      // Today + next 7 days should all exist
      for (let i = 0; i <= 7; i++) {
        const day = new Date(today.getTime() + i * MS_PER_DAY);
        const name = formatPartitionName(day);
        expect(partitions).toContain(name);
      }
    });

    it("should drop partitions older than 90 days", async () => {
      const today = todayUTC();

      // Create a partition 100 days in the past
      const oldDate = new Date(today.getTime() - 100 * MS_PER_DAY);
      const oldNextDay = new Date(oldDate.getTime() + MS_PER_DAY);
      const oldName = formatPartitionName(oldDate);
      createdPartitions.push(oldName);

      await db.webhookDeliveries.createPartition(
        oldName,
        formatDateStr(oldDate),
        formatDateStr(oldNextDay)
      );

      let partitions = await getPartitionNames();
      expect(partitions).toContain(oldName);

      // Run retention — should drop the old partition
      await processDeliveryRetention();

      partitions = await getPartitionNames();
      expect(partitions).not.toContain(oldName);
    });

    it("should not drop partitions within the 90-day window", async () => {
      const today = todayUTC();

      // Create a partition 30 days in the past (well within retention)
      const recentDate = new Date(today.getTime() - 30 * MS_PER_DAY);
      const recentNextDay = new Date(recentDate.getTime() + MS_PER_DAY);
      const recentName = formatPartitionName(recentDate);
      createdPartitions.push(recentName);

      await db.webhookDeliveries.createPartition(
        recentName,
        formatDateStr(recentDate),
        formatDateStr(recentNextDay)
      );

      await processDeliveryRetention();

      const partitions = await getPartitionNames();
      expect(partitions).toContain(recentName);

      // Clean up
      await db.webhookDeliveries.dropPartition(recentName);
    });
  });
});
