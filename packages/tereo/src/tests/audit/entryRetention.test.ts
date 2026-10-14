import { processEntryRetention } from "../../jobs/entryRetention.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import db from "../../utils/db/index.js";

/** Use UTC methods to match production code in entryRetention.ts */
function formatPartitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `audit_log_entries_${year}_${month}_${day}`;
}

function formatDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function todayUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

describe("Entry Retention", () => {
  describe("processEntryRetention", () => {
    it("should list existing partitions", async () => {
      const partitions = await db.auditLogEntries.listPartitions();
      expect(partitions.length).toBeGreaterThan(0);
      expect(partitions[0].child).toMatch(
        /^audit_log_entries_\d{4}_\d{2}_\d{2}$/
      );
    });

    it("should create future partitions including today + 7 days ahead", async () => {
      await processEntryRetention();

      const partitions = await db.auditLogEntries.listPartitions();
      const partitionNames = partitions.map((p) => p.child);

      const today = todayUTC();

      // Verify today + next 7 days all exist
      for (let i = 0; i <= 7; i++) {
        const day = new Date(today.getTime() + i * MS_PER_DAY);
        const name = formatPartitionName(day);
        expect(partitionNames).toContain(name);
      }
    });

    it("should create partition idempotently", async () => {
      // Run twice — second run should not error
      await processEntryRetention();
      await processEntryRetention();

      const partitions = await db.auditLogEntries.listPartitions();
      expect(partitions.length).toBeGreaterThan(0);
    });

    it("should drop partitions older than retention period", async () => {
      // Create a partition 100 days in the past
      const today = todayUTC();
      const oldDate = new Date(today.getTime() - 100 * MS_PER_DAY);
      const nextDate = new Date(oldDate.getTime() + MS_PER_DAY);
      const oldName = formatPartitionName(oldDate);

      await db.auditLogEntries.createPartition(
        oldName,
        formatDateStr(oldDate),
        formatDateStr(nextDate)
      );

      // Verify it exists
      let partitions = await db.auditLogEntries.listPartitions();
      expect(partitions.map((p) => p.child)).toContain(oldName);

      // Run retention — should drop the old partition
      await processEntryRetention();

      // Verify it was removed
      partitions = await db.auditLogEntries.listPartitions();
      expect(partitions.map((p) => p.child)).not.toContain(oldName);
    });

    it("should not drop partitions within retention window", async () => {
      // Create a partition 80 days in the past (within 90-day window)
      const today = todayUTC();
      const recentDate = new Date(today.getTime() - 80 * MS_PER_DAY);
      const nextDate = new Date(recentDate.getTime() + MS_PER_DAY);
      const recentName = formatPartitionName(recentDate);

      await db.auditLogEntries.createPartition(
        recentName,
        formatDateStr(recentDate),
        formatDateStr(nextDate)
      );

      // Run retention
      await processEntryRetention();

      // Verify it still exists
      const partitions = await db.auditLogEntries.listPartitions();
      expect(partitions.map((p) => p.child)).toContain(recentName);
    });

    it("should keep partition at exactly the retention boundary (90 days)", async () => {
      // A partition at exactly 90 days should be KEPT (cutoff uses <, not <=)
      const today = todayUTC();
      const boundaryDate = new Date(today.getTime() - 90 * MS_PER_DAY);
      const nextDate = new Date(boundaryDate.getTime() + MS_PER_DAY);
      const boundaryName = formatPartitionName(boundaryDate);

      await db.auditLogEntries.createPartition(
        boundaryName,
        formatDateStr(boundaryDate),
        formatDateStr(nextDate)
      );

      await processEntryRetention();

      const partitions = await db.auditLogEntries.listPartitions();
      // Partition at exactly cutoff should be kept (partDate < cutoff is false when equal)
      expect(partitions.map((p) => p.child)).toContain(boundaryName);
    });

    it("should drop partition one day past the retention boundary (91 days)", async () => {
      const today = todayUTC();
      const pastDate = new Date(today.getTime() - 91 * MS_PER_DAY);
      const nextDate = new Date(pastDate.getTime() + MS_PER_DAY);
      const pastName = formatPartitionName(pastDate);

      await db.auditLogEntries.createPartition(
        pastName,
        formatDateStr(pastDate),
        formatDateStr(nextDate)
      );

      await processEntryRetention();

      const partitions = await db.auditLogEntries.listPartitions();
      expect(partitions.map((p) => p.child)).not.toContain(pastName);
    });
  });

  describe("processEntryRetention end-to-end", () => {
    it("should drop old partitions and create future partitions in one run", async () => {
      const today = todayUTC();

      // Create a partition 100 days in the past (outside 90-day retention)
      const oldDate = new Date(today.getTime() - 100 * MS_PER_DAY);
      const oldNext = new Date(oldDate.getTime() + MS_PER_DAY);
      const oldName = formatPartitionName(oldDate);
      await db.auditLogEntries.createPartition(
        oldName,
        formatDateStr(oldDate),
        formatDateStr(oldNext)
      );

      // Create a partition 50 days in the past (inside retention window)
      const recentDate = new Date(today.getTime() - 50 * MS_PER_DAY);
      const recentNext = new Date(recentDate.getTime() + MS_PER_DAY);
      const recentName = formatPartitionName(recentDate);
      await db.auditLogEntries.createPartition(
        recentName,
        formatDateStr(recentDate),
        formatDateStr(recentNext)
      );

      // Run the full retention job
      await processEntryRetention();

      const partitions = await db.auditLogEntries.listPartitions();
      const names = partitions.map((p) => p.child);

      // Old partition should be dropped
      expect(names).not.toContain(oldName);

      // Recent partition should be kept
      expect(names).toContain(recentName);

      // Today + 7 future days should all exist
      for (let i = 0; i <= 7; i++) {
        const day = new Date(today.getTime() + i * MS_PER_DAY);
        expect(names).toContain(formatPartitionName(day));
      }
    });

    it("should handle gap between existing partitions and today", async () => {
      // processEntryRetention always creates today + 7 days ahead
      // regardless of existing partition state
      await processEntryRetention();

      const partitions = await db.auditLogEntries.listPartitions();
      const names = partitions.map((p) => p.child);

      const today = todayUTC();

      // Verify today exists
      expect(names).toContain(formatPartitionName(today));

      // Verify tomorrow exists
      const tomorrow = new Date(today.getTime() + MS_PER_DAY);
      expect(names).toContain(formatPartitionName(tomorrow));
    });
  });

  describe("a failing drop", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("still creates the coming days' partitions and drops the rest", async () => {
      const today = todayUTC();
      const old = [100, 101].map((ago) => {
        const day = new Date(today.getTime() - ago * MS_PER_DAY);
        return { day, name: formatPartitionName(day) };
      });
      for (const { day, name } of old) {
        await db.auditLogEntries.createPartition(
          name,
          formatDateStr(day),
          formatDateStr(new Date(day.getTime() + MS_PER_DAY))
        );
      }
      const lastAhead = formatPartitionName(
        new Date(today.getTime() + 7 * MS_PER_DAY)
      );
      await db.auditLogEntries.dropPartition(lastAhead);

      const drop = db.auditLogEntries.dropPartition;
      vi.spyOn(db.auditLogEntries, "dropPartition").mockImplementation(
        async (name) => {
          if (name === old[0].name) throw new Error("drop failed");
          return drop(name);
        }
      );

      await expect(processEntryRetention()).resolves.toBeUndefined();

      const names = (await db.auditLogEntries.listPartitions()).map(
        (p) => p.child
      );
      expect(names).toContain(lastAhead);
      expect(names).toContain(old[0].name);
      expect(names).not.toContain(old[1].name);

      vi.restoreAllMocks();
      await processEntryRetention();
    });
  });

  describe("Partition validation", () => {
    it("should reject invalid partition names", async () => {
      await expect(
        db.auditLogEntries.dropPartition("invalid_name")
      ).rejects.toThrow("Invalid partition name");
    });

    it("should reject invalid date strings in createPartition", async () => {
      await expect(
        db.auditLogEntries.createPartition(
          "audit_log_entries_2026_01_01",
          "not-a-date",
          "2026-01-02"
        )
      ).rejects.toThrow("Invalid date string");
    });

    it("should reject invalid partition name in createPartition", async () => {
      await expect(
        db.auditLogEntries.createPartition(
          "bad_name",
          "2026-01-01",
          "2026-01-02"
        )
      ).rejects.toThrow("Invalid partition name");
    });

    it("should reject invalid to-date in createPartition", async () => {
      await expect(
        db.auditLogEntries.createPartition(
          "audit_log_entries_2026_01_01",
          "2026-01-01",
          "invalid"
        )
      ).rejects.toThrow("Invalid date string");
    });
  });
});
