import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";

/**
 * The Redis adapter publishes every cross-node emit and subscribes without
 * handling the promise; index.ts exits on an unhandled rejection in
 * production, so a Redis outage must not turn an emit into one.
 */

const USER_ID = "00000000-0000-7001-0000-000000000001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WebSocket emits while the adapter's Redis is unreachable", () => {
  it("leave no unhandled rejection, before or after shutdown", async () => {
    const saved = {
      REDIS_URL: process.env.REDIS_URL,
      REDIS_SENTINELS: process.env.REDIS_SENTINELS,
    };
    vi.resetModules();
    // Nothing listens on port 1: stands in for an outage.
    process.env.REDIS_URL = "redis://127.0.0.1:1/0";
    delete process.env.REDIS_SENTINELS;

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    const previous = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", onRejection);

    const ws = await import("../websocket/index.js");
    try {
      await ws.initializeWebSocket(createServer());
      // What a role change or a revocation does. The pub client gives up on
      // a command after three retries, about 1.2s.
      ws.notifyUserRolesChanged(USER_ID);
      ws.disconnectUserSockets(USER_ID);
      await sleep(3000);
      expect(rejections).toEqual([]);

      // The subscribes still queued, and emits through the stale server.
      await ws.shutdownWebSocket();
      ws.notifyUserRolesChanged(USER_ID);
      await sleep(500);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      for (const l of previous) process.on("unhandledRejection", l);
      await ws.shutdownWebSocket().catch(() => undefined);
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      vi.resetModules();
    }
  }, 30_000);
});
