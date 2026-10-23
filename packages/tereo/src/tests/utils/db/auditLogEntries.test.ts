// @module-tag int
// @module-tag audit
import { describe, it, expect } from "vitest";
import db from "../../../utils/db/index.js";

describe("createPartition and dropPartition", () => {
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
