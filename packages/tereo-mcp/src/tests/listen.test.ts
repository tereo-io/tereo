import { createServer, request, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import { connect } from "./support/connect.js";
import type { AddressInfo } from "node:net";
import express from "express";
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

async function setup() {
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

  const mcp = createTereoMcp({
    name: "quotes",
    version: "1.0.0",
    core: fakeCore(),
    publicUrl: "https://mcp.example.test",
    allowedClients: ["claude"],
    rateLimit: false,
    coreUrl: `http://127.0.0.1:${corePort}/core`,
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
  const server = await mcp.listen(0, "127.0.0.1");
  cleanups.push(() => server.close());
  return { mcp, server, release, inHandler };
}

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
});
