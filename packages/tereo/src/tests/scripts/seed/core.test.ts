// @module-tag int
// @module-tag notifications
// @module-tag platform
import { ensurePartitions } from "../../../scripts/seed/core.js";
import { partitionName } from "../../../utils/partitions.js";
import { describe, it, expect } from "vitest";
import db from "../../../utils/db/index.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const names = async (table: "notifications" | "notificationDeliveries") =>
  (await db.notifications.listPartitions(table)).map((p) => p.child);

describe("ensurePartitions", () => {
  describe("seed partitions", () => {
    it("creates notification partitions either side of today", async () => {
      await ensurePartitions(2);
      const today = new Date();
      for (const offset of [-2, 0, 2]) {
        const day = new Date(today.getTime() + offset * MS_PER_DAY);
        expect(await names("notifications")).toContain(
          partitionName("notifications", day)
        );
        expect(await names("notificationDeliveries")).toContain(
          partitionName("notificationDeliveries", day)
        );
      }
    });
  });
});
