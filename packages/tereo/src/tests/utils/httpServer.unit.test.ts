// @module-tag unit
// @module-tag platform
import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import express from "express";
import {
  closeHttpServer,
  isUploadRequest,
  requestDeadline,
  tuneServerKeepAlive,
} from "../../utils/httpServer.js";

describe("isUploadRequest", () => {
  it.each([
    ["PUT", "/v1/files/buckets/b/objects/docs/a.pdf"],
    ["PUT", "/v1/files/buckets/b/multipart/u/parts/3"],
    ["PUT", "/v1/files/signed/objects/b/by-id/o"],
    ["POST", "/v1/account/photo"],
    ["PUT", "/V1/Files/Buckets/b/Objects/a.pdf"],
  ])("%s %s is an upload", (method, path) => {
    expect(isUploadRequest(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/v1/files/buckets/b/objects/a.pdf"],
    ["PUT", "/v1/files/buckets/b"],
    ["POST", "/v1/files/buckets/b/multipart"],
    ["POST", "/v1/audit/entries/batch"],
    ["DELETE", "/v1/account/photo"],
  ])("%s %s is not", (method, path) => {
    expect(isUploadRequest(method, path)).toBe(false);
  });
});

describe("requestDeadline", () => {
  const listen = async (timeoutMs: number) => {
    const app = express();
    app.use(requestDeadline(timeoutMs));
    // Reads the body, as a parser or upload would.
    app.all("/{*any}", (req, res) => {
      req.resume();
      req.on("end", () => res.status(200).end("ok"));
    });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    return server;
  };

  /** Sends headers announcing 100 bytes, then `sent` of them, and waits. */
  const dribble = (server: Server, method: string, path: string, sent = 10) =>
    new Promise<{ response: string; closed: boolean }>((resolve) => {
      const { port } = server.address() as AddressInfo;
      const socket = connect(port, "127.0.0.1");
      let response = "";
      socket.on("data", (chunk) => (response += chunk.toString()));
      socket.on("close", () => resolve({ response, closed: true }));
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n` +
          "x".repeat(sent)
      );
      setTimeout(() => {
        socket.destroy();
        resolve({ response, closed: false });
      }, 600);
    });

  it("answers 408 and closes when the body is late", async () => {
    const server = await listen(150);
    try {
      const { response, closed } = await dribble(server, "POST", "/v1/x");
      expect(response).toMatch(/^HTTP\/1\.1 408/);
      expect(response).toContain("request_timeout");
      expect(closed).toBe(true);
    } finally {
      server.close();
    }
  });

  it("leaves upload routes to the server's own limit", async () => {
    const server = await listen(150);
    try {
      const { response, closed } = await dribble(
        server,
        "PUT",
        "/v1/files/buckets/b/objects/a.bin"
      );
      expect(response).toBe("");
      expect(closed).toBe(false);
    } finally {
      server.close();
    }
  });

  it("lets a request whose body arrives in time through", async () => {
    const server = await listen(150);
    try {
      const { response } = await dribble(server, "POST", "/v1/x", 100);
      expect(response).toMatch(/^HTTP\/1\.1 200/);
    } finally {
      server.close();
    }
  });
});

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
