import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  closeHttpServer,
  tuneServerKeepAlive,
} from "../../utils/httpServer.js";

describe("tuneServerKeepAlive", () => {
  it("raises keepAliveTimeout above the 5s client idle close, with headersTimeout above it", () => {
    const server = createServer();
    tuneServerKeepAlive(server);
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    server.close();
  });
});

describe("closeHttpServer", () => {
  it("closes upgraded connections and resolves on a server that never listened", async () => {
    const closeUpgraded = vi.fn(async () => undefined);
    await expect(
      closeHttpServer(createServer(), closeUpgraded, 1_000)
    ).resolves.toBeUndefined();
    expect(closeUpgraded).toHaveBeenCalledOnce();
  });
});
