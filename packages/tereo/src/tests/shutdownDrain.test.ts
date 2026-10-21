import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { connect } from "node:net";

const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

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
