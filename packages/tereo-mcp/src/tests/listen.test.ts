import { createServer, request, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Listening, ListenOptions } from "../index.js";
import type { TereoMcpOptions } from "../types.js";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import { connect } from "./support/connect.js";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import express from "express";
import pino from "pino";
import { z } from "zod";

const ISSUER = "https://tereo.example.test";
const metadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  response_types_supported: ["code"],
};
const token = "test-token-u1|client=claude|perms=q.items.read";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(
  extra: Partial<TereoMcpOptions> = {},
  listenOptions: ListenOptions = { signals: false }
) {
  const coreApp = express();
  coreApp.get("/core/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(metadata);
  });
  const coreServer: HttpServer = createServer(coreApp);
  await new Promise<void>((resolve) =>
    coreServer.listen(0, "127.0.0.1", resolve)
  );
  cleanups.push(
    () => new Promise<void>((resolve) => coreServer.close(() => resolve()))
  );
  const corePort = (coreServer.address() as AddressInfo).port;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inHandler = new Promise<void>((resolve) => (entered = resolve));
  let enteredHang!: () => void;
  const inHang = new Promise<void>((resolve) => (enteredHang = resolve));

  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "debug" },
    { write: (s: string) => lines.push(JSON.parse(s)) }
  ) as Logger;
  const mcp = createTereoMcp({
    name: "quotes",
    version: "1.0.0",
    core: fakeCore(),
    publicUrl: "https://mcp.example.test",
    allowedClients: ["claude"],
    rateLimit: false,
    coreUrl: `http://127.0.0.1:${corePort}/core`,
    logger,
    ...extra,
  });
  mcp.define({
    name: "slow",
    description: "Waits for the test",
    permission: "q.items.read",
    readOnly: true,
    input: z.object({}),
    handler: async () => {
      entered();
      await gate;
      return "finished";
    },
  });
  mcp.define({
    name: "hang",
    description: "Never returns",
    permission: "q.items.read",
    readOnly: true,
    input: z.object({}),
    handler: () => {
      enteredHang();
      return new Promise(() => undefined);
    },
  });
  const server: Listening = await mcp.listen(0, "127.0.0.1", listenOptions);
  cleanups.push(() => server.close());
  return { mcp, server, release, inHandler, inHang, lines };
}

const raw = (
  port: number,
  opts: { headers?: Record<string, string>; body?: string }
) =>
  new Promise<{ status: number; type: string; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...opts.headers,
          },
        },
        (r) => {
          let body = "";
          r.setEncoding("utf8");
          r.on("data", (chunk: string) => (body += chunk));
          r.on("end", () =>
            resolve({
              status: r.statusCode ?? 0,
              type: r.headers["content-type"] ?? "",
              body,
            })
          );
        }
      );
      req.on("error", reject);
      req.end(
        opts.body ??
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      );
    }
  );

describe("listen", () => {
  it("reports its port and answers /health without a token", async () => {
    const { server } = await setup();

    expect(server.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  const statusWithHost = (port: number, path: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: path === "/mcp" ? "POST" : "GET",
          headers: { host, "content-type": "application/json" },
        },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end(path === "/mcp" ? "{}" : undefined);
    });

  it("refuses a foreign Host header with 403 before auth", async () => {
    const { server } = await setup();

    expect(await statusWithHost(server.port, "/mcp", "evil.example")).toBe(403);
  });

  it("answers /health for any Host, while the MCP path stays behind host validation", async () => {
    const { server } = await setup();

    expect(await statusWithHost(server.port, "/health", "10.1.2.3:4002")).toBe(
      200
    );
    expect(await statusWithHost(server.port, "/mcp", "10.1.2.3:4002")).toBe(
      403
    );
    expect(
      await statusWithHost(server.port, "/health", "mcp.example.test")
    ).toBe(200);
  });

  it("lets an in-flight tool call finish before close() resolves, then refuses new connections", async () => {
    const { server, release, inHandler } = await setup();
    const client = await connect(server.url, token);

    const call = client.callTool({ name: "slow", arguments: {} });
    await inHandler;
    let closed = false;
    const closing = server.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(closed).toBe(false);

    release();
    const result = await call;
    await closing;

    expect(result.content).toEqual([{ type: "text", text: "finished" }]);
    await expect(
      fetch(`http://127.0.0.1:${server.port}/health`)
    ).rejects.toThrow();
    await expect(server.close()).resolves.toBeUndefined();
    await client.close().catch(() => undefined);
  });

  it("drops a request still running at shutdownTimeoutMs, and close() resolves", async () => {
    const { server, inHang } = await setup(
      {},
      { signals: false, shutdownTimeoutMs: 200 }
    );
    const client = await connect(server.url, token);

    const call = client.callTool(
      { name: "hang", arguments: {} },
      {
        timeout: 5_000,
      }
    );
    const outcome = call.then(
      () => "answered",
      (err: Error) => err
    );
    await inHang;
    const started = Date.now();
    await server.close();

    expect(Date.now() - started).toBeLessThan(2_000);
    const dropped = await outcome;
    expect(dropped).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2_000);
    await client.close().catch(() => undefined);
  });

  it("with signals: false installs no signal listeners", async () => {
    const term = process.listenerCount("SIGTERM");
    const int = process.listenerCount("SIGINT");

    const { server } = await setup({}, { signals: false });

    expect(process.listenerCount("SIGTERM")).toBe(term);
    expect(process.listenerCount("SIGINT")).toBe(int);
    await server.close();
    expect(process.listenerCount("SIGTERM")).toBe(term);
    expect(process.listenerCount("SIGINT")).toBe(int);
  });

  it("listens once for a signal listed twice, and close() removes it", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const term = process.listenerCount("SIGTERM");

      const { server } = await setup({}, { signals: ["SIGTERM", "SIGTERM"] });

      expect(process.listenerCount("SIGTERM")).toBe(term + 1);
      await server.close();
      expect(process.listenerCount("SIGTERM")).toBe(term);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("by default listens for SIGTERM and SIGINT once each, and close() removes them", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const term = process.listenerCount("SIGTERM");
      const int = process.listenerCount("SIGINT");

      const { server } = await setup({}, {});

      expect(process.listenerCount("SIGTERM")).toBe(term + 1);
      expect(process.listenerCount("SIGINT")).toBe(int + 1);
      await server.close();
      expect(process.listenerCount("SIGTERM")).toBe(term);
      expect(process.listenerCount("SIGINT")).toBe(int);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it.each([
    [{ shutdownTimeoutMs: 0 }, /shutdownTimeoutMs/],
    [{ shutdownTimeoutMs: 1.5 }, /shutdownTimeoutMs/],
    [{ shutdownTimeoutMs: Number.NaN }, /shutdownTimeoutMs/],
    [{ signals: [""] as unknown as NodeJS.Signals[] }, /signals/],
  ])("refuses listen options %o", async (bad, message) => {
    const { mcp } = await setup();

    const attempt = mcp.listen(0, "127.0.0.1", { signals: false, ...bad });

    await expect(attempt).rejects.toThrow(/cannot start/);
    await expect(attempt).rejects.toThrow(message);
  });

  describe("allowedOrigins", () => {
    const allowedOrigins = ["https://app.example.com"];

    it("allows a listed browser origin", async () => {
      const { server } = await setup({ allowedOrigins });

      const res = await raw(server.port, {
        headers: { origin: "https://app.example.com" },
      });

      expect(res.status).toBe(401);
    });

    it("refuses an unlisted origin with 403", async () => {
      const { server } = await setup({ allowedOrigins });

      const res = await raw(server.port, {
        headers: { origin: "https://evil.example.com" },
      });

      expect(res.status).toBe(403);
    });

    it("still allows a loopback origin on a loopback bind", async () => {
      const { server } = await setup({ allowedOrigins });

      const res = await raw(server.port, {
        headers: { origin: "http://localhost:3000" },
      });

      expect(res.status).toBe(401);
    });

    it("lets a request with no Origin through", async () => {
      const { server } = await setup({ allowedOrigins });

      expect((await raw(server.port, {})).status).toBe(401);
    });
  });

  it("answers a malformed JSON body with a JSON 400 and no stack", async () => {
    const { server, lines } = await setup();

    const res = await raw(server.port, { body: "{not json" });

    expect(res.status).toBe(400);
    expect(res.type).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_request" });
    expect(res.body).not.toContain("at ");
    expect(res.body).not.toContain("/");
    expect(JSON.stringify(lines)).not.toContain("not json");
  });
});
