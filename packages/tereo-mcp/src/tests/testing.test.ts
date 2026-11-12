import { afterEach, describe, expect, it } from "vitest";
import { createTestClient } from "../testing.js";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import express from "express";

const ISSUER = "https://tereo.example.test";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe("createTestClient", () => {
  it("lists and calls a tool with a test token, and close() stops the server", async () => {
    const coreApp = express();
    coreApp.get("/core/.well-known/oauth-authorization-server", (_req, res) => {
      res.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        response_types_supported: ["code"],
      });
    });
    const coreServer = createServer(coreApp);
    await new Promise<void>((resolve) =>
      coreServer.listen(0, "127.0.0.1", resolve)
    );
    cleanups.push(
      () => new Promise<void>((resolve) => coreServer.close(() => resolve()))
    );
    const corePort = (coreServer.address() as AddressInfo).port;

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
      name: "ping",
      description: "Answers",
      permission: null,
      readOnly: true,
      handler: () => "pong",
    });

    let listenedUrl = "";
    const listen = mcp.listen.bind(mcp);
    mcp.listen = async (port, host) => {
      const server = await listen(port, host);
      listenedUrl = server.url;
      return server;
    };

    const { client, close } = await createTestClient(mcp, {
      token: "test-token-u1|client=claude|perms=",
    });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);

    await close();
    expect(listenedUrl).not.toBe("");
    await expect(fetch(listenedUrl)).rejects.toThrow();
  });
});
