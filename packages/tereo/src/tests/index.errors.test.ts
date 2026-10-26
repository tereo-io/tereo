// @module-tag int
// @module-tag platform
import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";

describe("createAppServer", () => {
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
