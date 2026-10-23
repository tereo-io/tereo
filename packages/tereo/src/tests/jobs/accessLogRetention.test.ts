// @module-tag int
// @module-tag files
// @module-tag job
import { runAccessLogRetention } from "../../jobs/accessLogRetention.js";
import { prisma } from "../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import env from "../../env.js";

describe("runAccessLogRetention", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  it("deletes rows older than ACCESS_LOG_RETENTION_DAYS and keeps the rest", async () => {
    const now = new Date();
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS);
    const row = (requestId: string, timestamp: Date) => ({
      operation: "TEST",
      statusCode: 200,
      ipAddress: "127.0.0.1",
      requestId,
      timestamp,
    });
    const expired = randomUUID();
    const kept = randomUUID();
    await prisma.accessLog.createMany({
      data: [
        row(expired, at(env.ACCESS_LOG_RETENTION_DAYS + 1)),
        row(kept, at(env.ACCESS_LOG_RETENTION_DAYS - 1)),
      ],
    });

    try {
      expect(await runAccessLogRetention(now)).toBeGreaterThanOrEqual(1);
      const left = await prisma.accessLog.findMany({
        where: { requestId: { in: [expired, kept] } },
        select: { requestId: true },
      });
      expect(left.map((r) => r.requestId)).toEqual([kept]);
    } finally {
      await prisma.accessLog.deleteMany({
        where: { requestId: { in: [expired, kept] } },
      });
    }
  });
});
