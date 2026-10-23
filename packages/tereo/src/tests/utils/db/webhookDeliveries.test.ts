// @module-tag int
// @module-tag webhooks
import { describe, it, expect, afterAll } from "vitest";
import db from "../../../utils/db/index.js";

function formatPartitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `webhook_deliveries_${year}_${month}_${day}`;
}

function formatDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

async function getPartitionNames(): Promise<string[]> {
  const partitions = await db.webhookDeliveries.listPartitions();
  return partitions.map((p) => p.child);
}

describe("listPartitions, createPartition and dropPartition", () => {
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
  });
});
