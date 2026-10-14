import { closeHttpServer } from "../utils/httpServer.js";
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  disconnectWebSocketClients,
  initializeWebSocket,
  shutdownWebSocket,
} from "../websocket/index.js";

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port)
    );
  });

describe("shutdown with a connected WebSocket client", () => {
  it("closes the HTTP server without waiting out the drain window", async () => {
    const server = createServer();
    await initializeWebSocket(server);
    const port = await listen(server);

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/?EIO=4&transport=websocket`
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    const wsClosed = new Promise<void>((resolve) =>
      ws.addEventListener("close", () => resolve())
    );

    try {
      const started = Date.now();
      // A drain window far beyond the test timeout: only closing the
      // upgraded socket lets this resolve.
      await closeHttpServer(server, disconnectWebSocketClients, 600_000);
      expect(Date.now() - started).toBeLessThan(5_000);
      await wsClosed;
    } finally {
      await shutdownWebSocket();
      server.closeAllConnections();
    }
  }, 15_000);
});
