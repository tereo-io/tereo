import { createServer, request, type Server as HttpServer } from "node:http";
import { hostHeaderValidation, originValidation } from "../index.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TereoMcpOptions } from "../types.js";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import { startStubCore } from "../testing.js";
import type { AddressInfo } from "node:net";
import express from "express";
import pino from "pino";

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const options = async (): Promise<TereoMcpOptions> => {
  const stub = await startStubCore();
  cleanups.push(() => stub.close());
  return {
    name: "quotes",
    version: "1.0.0",
    core: fakeCore(),
    publicUrl: "https://mcp.example.test",
    allowedClients: ["claude"],
    allowedOrigins: ["https://app.example.com"],
    rateLimit: false,
    coreUrl: stub.coreUrl,
    logger: pino({ level: "silent" }),
  };
};

const listenPort = async (): Promise<number> => {
  const server = await createTereoMcp(await options()).listen(0, "127.0.0.1", {
    signals: false,
  });
  cleanups.push(() => server.close());
  return server.port;
};

// The host app a router() user writes, allowing what listen() allows on a
// loopback bind for the same publicUrl and allowedOrigins.
const hostAppPort = async (): Promise<number> => {
  const app = express();
  app.use(hostHeaderValidation(["mcp.example.test", ...LOOPBACK]));
  app.use(originValidation(["app.example.com", ...LOOPBACK]));
  app.use(await createTereoMcp(await options()).router());
  const server: HttpServer = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  );
  return (server.address() as AddressInfo).port;
};

const post = (port: number, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (r) => {
        let body = "";
        r.setEncoding("utf8");
        r.on("data", (chunk: string) => (body += chunk));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });

// With no token, a request that passes both checks reaches bearer auth: 401.
const cases: [string, Record<string, string>, number][] = [
  ["an allowed Host", { host: "mcp.example.test" }, 401],
  ["an allowed Host with a port", { host: "mcp.example.test:8443" }, 401],
  ["a Host that is not allowed", { host: "evil.example" }, 403],
  ["a loopback Host", { host: "127.0.0.1:4002" }, 401],
  [
    "an allowed Origin",
    { host: "mcp.example.test", origin: "https://app.example.com" },
    401,
  ],
  [
    "an Origin that is not allowed",
    { host: "mcp.example.test", origin: "https://evil.example.com" },
    403,
  ],
  [
    "a loopback Origin",
    { host: "mcp.example.test", origin: "http://localhost:3000" },
    401,
  ],
  ["an opaque Origin", { host: "mcp.example.test", origin: "null" }, 403],
];

describe("hostHeaderValidation and originValidation", () => {
  it.each(cases)("answer %s as listen() does", async (_, headers, status) => {
    const [own, listened] = await Promise.all([
      post(await hostAppPort(), headers),
      post(await listenPort(), headers),
    ]);

    expect(own.status).toBe(status);
    expect(own).toEqual(listened);
  });

  it("refuse a Host that is not allowed with a JSON-RPC error", async () => {
    const res = await post(await hostAppPort(), { host: "evil.example" });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid Host: evil.example" },
      id: null,
    });
  });

  it("let a request without Origin through", async () => {
    const res = await post(await hostAppPort(), { host: "mcp.example.test" });

    expect(res.status).toBe(401);
  });

  it("copy the allowed list, so changing it afterwards changes nothing", async () => {
    const hosts = ["mcp.example.test"];
    const app = express();
    app.use(hostHeaderValidation(hosts));
    app.post("/mcp", (_req, res) => {
      res.sendStatus(204);
    });
    hosts.push("evil.example");
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve()))
    );
    const port = (server.address() as AddressInfo).port;

    expect((await post(port, { host: "evil.example" })).status).toBe(403);
    expect((await post(port, { host: "mcp.example.test" })).status).toBe(204);
  });
});
