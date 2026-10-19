import { CORE_SERVICE } from "../definitions/coreService.js";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../utils/db/prisma.js";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import db from "../utils/db/index.js";
import {
  ensureCurrentPartitions,
  partitionName,
  utcDay,
} from "../utils/partitions.js";

describe("createAppServer on a port already in use", () => {
  it("rejects start() with EADDRINUSE, and stop() still tears everything down", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, () => resolve()));
    const port = (taken.address() as AddressInfo).port;

    const savedRole = process.env.ROLE;
    // A fresh module graph with ROLE=api, so no worker runs in this process.
    vi.resetModules();
    process.env.ROLE = "api";
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    const previous = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", onUncaught);

    const { createAppServer } = await import("../index.js");
    const app = createAppServer(port);
    try {
      const started = await Promise.race([
        app.start().then(
          () => "started",
          (err: NodeJS.ErrnoException) => `rejected:${err.code}`
        ),
        new Promise<string>((r) => setTimeout(() => r("still pending"), 8000)),
      ]);
      expect(started).toBe("rejected:EADDRINUSE");
      expect(uncaught).toEqual([]);

      await expect(app.stop()).resolves.toBeUndefined();
      expect(app.isRunning()).toBe(false);
    } finally {
      process.off("uncaughtException", onUncaught);
      for (const l of previous) process.on("uncaughtException", l);
      await app.stop().catch(() => undefined);
      await new Promise<void>((resolve) => taken.close(() => resolve()));
      if (savedRole === undefined) delete process.env.ROLE;
      else process.env.ROLE = savedRole;
      vi.resetModules();
    }
  }, 30_000);
});

describe("createAppServer without today's audit partition", () => {
  it("creates the partition before the first audited write of the start", async () => {
    const today = partitionName("audit", utcDay());
    const stash = `${today}_stash`;
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "audit"."audit_log_entries" DETACH PARTITION "audit"."${today}"`
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "audit"."${today}" RENAME TO "${stash}"`
    );
    // Re-registering core's declaration writes an audit entry.
    await prisma.service.update({
      where: { id: CORE_SERVICE.id },
      data: { declarationHash: null },
    });

    const savedRole = process.env.ROLE;
    vi.resetModules();
    process.env.ROLE = "api";
    const { createAppServer } = await import("../index.js");
    const app = createAppServer(0);
    try {
      await expect(app.start()).resolves.toBeUndefined();
      const audit = (await db.auditLogEntries.listPartitions()).map(
        (p) => p.child
      );
      expect(audit).toContain(today);
      const entries = await prisma.auditLogEntry.count({
        where: {
          entityId: CORE_SERVICE.id,
          createdAt: { gte: utcDay() },
          action: "UPDATE",
        },
      });
      expect(entries).toBeGreaterThan(0);
    } finally {
      await app.stop().catch(() => undefined);
      if (savedRole === undefined) delete process.env.ROLE;
      else process.env.ROLE = savedRole;
      vi.resetModules();
      // Today's partition exists again either way; put the stashed rows back
      // into it.
      await ensureCurrentPartitions();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "audit"."audit_log_entries" SELECT * FROM "audit"."${stash}"`
      );
      await prisma.$executeRawUnsafe(`DROP TABLE "audit"."${stash}"`);
    }
  }, 60_000);
});
