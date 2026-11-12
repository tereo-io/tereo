import { createTestClient, startStubCore } from "../testing.js";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import pino from "pino";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe("startStubCore", () => {
  it("serves authorization-server metadata whose issuer is its own URL, until closed", async () => {
    const stub = await startStubCore();

    const res = await fetch(
      `${stub.coreUrl}/.well-known/oauth-authorization-server`
    );
    const doc = (await res.json()) as Record<string, unknown>;

    expect(stub.coreUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(doc).toMatchObject({
      issuer: stub.coreUrl,
      authorization_endpoint: `${stub.coreUrl}/oauth/authorize`,
      token_endpoint: `${stub.coreUrl}/oauth/token`,
    });
    await stub.close();
    await expect(
      fetch(`${stub.coreUrl}/.well-known/oauth-authorization-server`)
    ).rejects.toThrow();
  });
});

describe("createTestClient", () => {
  it("lists and calls a tool with a test token, and close() stops the server", async () => {
    const stub = await startStubCore();
    cleanups.push(() => stub.close());

    const mcp = createTereoMcp({
      name: "quotes",
      version: "1.0.0",
      core: fakeCore(),
      publicUrl: "https://mcp.example.test",
      allowedClients: ["claude"],
      rateLimit: false,
      coreUrl: stub.coreUrl,
      logger: pino({ level: "silent" }),
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
