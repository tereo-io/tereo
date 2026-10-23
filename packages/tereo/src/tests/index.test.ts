// @module-tag int
// @module-tag platform
import { CORE_SERVICE } from "../definitions/coreService.js";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../utils/db/prisma.js";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import db from "../utils/db/index.js";
import { connect } from "node:net";
import {
  ensureCurrentPartitions,
  partitionName,
  utcDay,
} from "../utils/partitions.js";

const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

describe("createAppServer", () => {
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

  describe("stopping a ROLE=all process", () => {
    it("drains HTTP and stops the workers side by side, each within SHUTDOWN_TIMEOUT_SECONDS", async () => {
      const saved = {
        ROLE: process.env.ROLE,
        SHUTDOWN_TIMEOUT_SECONDS: process.env.SHUTDOWN_TIMEOUT_SECONDS,
      };
      // A fresh module graph, so the database and Redis clients this server
      // closes are not the test process's own.
      vi.resetModules();
      process.env.ROLE = "all";
      process.env.SHUTDOWN_TIMEOUT_SECONDS = "1";
      const closeWorkerQueues = vi.fn(async () => undefined);
      vi.doMock("../worker.js", () => ({
        startWorker: async () => undefined,
        // A job that never finishes.
        stopWorker: () => new Promise<void>(() => {}),
        closeWorkerQueues,
      }));

      const port = await freePort();
      const { createAppServer } = await import("../index.js");
      const app = createAppServer(port);
      let socket: ReturnType<typeof connect> | undefined;
      try {
        await app.start();
        // A request whose body never arrives: in flight until forced closed.
        socket = connect(port, "127.0.0.1");
        await new Promise<void>((resolve) => socket!.once("connect", resolve));
        socket.write(
          "POST /oauth/token HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"
        );
        await new Promise((r) => setTimeout(r, 100));

        const startedAt = Date.now();
        const stopped = await app.stop().then(
          () => "resolved",
          (err: unknown) => err
        );
        const elapsed = Date.now() - startedAt;

        // The worker step failed at the deadline; everything after it ran.
        expect(stopped).toBeInstanceOf(AggregateError);
        expect(closeWorkerQueues).toHaveBeenCalledOnce();
        expect(app.isRunning()).toBe(false);
        // One deadline, not one after the other.
        expect(elapsed).toBeGreaterThanOrEqual(950);
        expect(elapsed).toBeLessThan(1_900);
      } finally {
        socket?.destroy();
        await app.stop().catch(() => undefined);
        vi.doUnmock("../worker.js");
        vi.resetModules();
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }, 30_000);
  });
});
