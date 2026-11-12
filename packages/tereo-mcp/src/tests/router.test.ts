import { createServer, type Server as HttpServer } from "node:http";
import type { TereoMcpOptions, ToolContext } from "../types.js";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCore } from "./support/fakeCore.js";
import { createTereoMcp } from "../tereoMcp.js";
import { connect } from "./support/connect.js";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import express from "express";
import { z } from "zod";
import pino from "pino";

const ISSUER = "https://tereo.example.test";
const metadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  response_types_supported: ["code"],
};

const token = (user: string, perms: string) =>
  `test-token-${user}|client=claude|perms=${perms}`;

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

async function listening() {
  const app = express();
  const metadataHits = { count: 0 };
  app.get("/core/.well-known/oauth-authorization-server", (_req, res) => {
    metadataHits.count++;
    res.json(metadata);
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "debug" },
    { write: (s: string) => lines.push(JSON.parse(s)) }
  ) as Logger;
  const options = (extra: Partial<TereoMcpOptions> = {}): TereoMcpOptions => ({
    name: "quotes",
    version: "1.0.0",
    core: fakeCore(),
    publicUrl: base,
    allowedClients: ["claude"],
    rateLimit: false,
    coreUrl: `${base}/core`,
    logger,
    ...extra,
  });
  return { app, base, mcpUrl: `${base}/mcp`, metadataHits, lines, options };
}

async function standard() {
  const h = await listening();
  const mcp = createTereoMcp(h.options());
  const calls: { tool: string; input: unknown; ctx: ToolContext }[] = [];
  mcp.define({
    name: "open_tool",
    description: "Open to every caller",
    permission: null,
    readOnly: true,
    handler: (input, ctx) => {
      calls.push({ tool: "open_tool", input, ctx });
      return "open";
    },
  });
  mcp.define({
    name: "read_tool",
    description: "Reads items",
    permission: "q.items.read",
    readOnly: true,
    input: z.object({ id: z.string() }),
    handler: (input, ctx) => {
      calls.push({ tool: "read_tool", input, ctx });
      return { read: (input as { id: string }).id };
    },
  });
  mcp.define({
    name: "admin_tool",
    description: "Deletes items",
    permission: "q.items.delete",
    readOnly: false,
    destructive: true,
    handler: (input, ctx) => {
      calls.push({ tool: "admin_tool", input, ctx });
      return "deleted";
    },
  });
  h.app.use(await mcp.router());
  return { ...h, mcp, calls };
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    (result) => ({ result }),
    (err: { code?: unknown; message?: string }) => ({
      error: { code: err.code, message: err.message },
    })
  );

describe("TereoMcp router", () => {
  it("answers a missing token with 401 and a resource_metadata challenge naming Tereo's issuer", async () => {
    const { base, mcpUrl } = await standard();

    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
    );
    const doc = await fetch(
      `${base}/.well-known/oauth-protected-resource/mcp`
    ).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(doc.resource).toBe(mcpUrl);
    expect(doc.authorization_servers).toEqual([ISSUER]);
  });

  it("lists only the tools the caller's permissions allow", async () => {
    const { mcpUrl } = await standard();
    const client = await connect(mcpUrl, token("user-1", "q.items.write"));

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(["open_tool", "read_tool"]);
    await client.close();
  });

  it("answers a tool the caller may not use exactly as an unknown tool", async () => {
    const { mcpUrl, calls } = await standard();
    const client = await connect(mcpUrl, token("user-1", "q.items.write"));

    const hidden = await outcome(
      client.callTool({ name: "admin_tool", arguments: {} })
    );
    const unknown = await outcome(
      client.callTool({ name: "no_such_tool", arguments: {} })
    );

    expect(JSON.stringify(hidden).replaceAll("admin_tool", "<name>")).toEqual(
      JSON.stringify(unknown).replaceAll("no_such_tool", "<name>")
    );
    expect(calls).toEqual([]);
    await client.close();
  });

  it("runs a permitted tool with the caller's context", async () => {
    const { mcpUrl, calls } = await standard();
    const client = await connect(mcpUrl, token("user-1", "q.items.write"));

    const read = await client.callTool({
      name: "read_tool",
      arguments: { id: "abc" },
    });
    const open = await client.callTool({ name: "open_tool" });

    expect(read.content).toEqual([{ type: "text", text: '{"read":"abc"}' }]);
    expect(open.content).toEqual([{ type: "text", text: "open" }]);
    expect(calls.map((c) => [c.tool, c.input])).toEqual([
      ["read_tool", { id: "abc" }],
      ["open_tool", undefined],
    ]);
    expect(calls[0].ctx.auth.userId).toBe("user-1");
    expect(calls[0].ctx.requestId).toEqual(expect.any(String));
    expect(calls[0].ctx.requestId).not.toBe(calls[1].ctx.requestId);
    await client.close();
  });

  it("builds a function input per caller", async () => {
    const h = await listening();
    const mcp = createTereoMcp(h.options());
    mcp.define({
      name: "shaped",
      description: "Schema depends on the caller",
      permission: null,
      readOnly: true,
      input: (ctx) =>
        ctx.auth.userId === "alice"
          ? z.object({ alpha: z.string() })
          : z.object({ beta: z.number() }),
      handler: () => "ok",
    });
    h.app.use(await mcp.router());

    const schemaFor = async (user: string) => {
      const client = await connect(h.mcpUrl, token(user, ""));
      const { tools } = await client.listTools();
      await client.close();
      return Object.keys(tools[0].inputSchema.properties ?? {});
    };

    expect(await schemaFor("alice")).toEqual(["alpha"]);
    expect(await schemaFor("bob")).toEqual(["beta"]);
  });

  it("leaves out a tool whose input function throws and keeps the others", async () => {
    const h = await listening();
    const mcp = createTereoMcp(h.options());
    mcp.define({
      name: "broken",
      description: "Its schema cannot be built",
      permission: null,
      readOnly: true,
      input: async () => {
        throw new Error("schema lookup failed");
      },
      handler: () => "never",
    });
    mcp.define({
      name: "fine",
      description: "Works",
      permission: null,
      readOnly: true,
      handler: () => "fine",
    });
    h.app.use(await mcp.router());
    const client = await connect(h.mcpUrl, token("user-1", ""));

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: "fine" });

    expect(tools.map((t) => t.name)).toEqual(["fine"]);
    expect(result.content).toEqual([{ type: "text", text: "fine" }]);
    const logged = h.lines.filter(
      (l) => l.msg === "MCP tool input schema failed"
    );
    expect(logged.length).toBeGreaterThan(0);
    expect(logged[0]).toMatchObject({
      level: 50,
      tool: "broken",
      user_id: "user-1",
      err: { message: "schema lookup failed" },
    });
    await client.close();
  });

  it("sets the annotations from the definition", async () => {
    const { mcpUrl } = await standard();
    const client = await connect(mcpUrl, token("user-1", "q.items.delete"));

    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.read_tool.annotations).toEqual({ readOnlyHint: true });
    expect(byName.admin_tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    await client.close();
  });

  it("returns an isError result for arguments that fail the schema, without calling the handler", async () => {
    const { mcpUrl, calls } = await standard();
    const client = await connect(mcpUrl, token("user-1", "q.items.read"));

    const result = await client.callTool({
      name: "read_tool",
      arguments: { id: 42 },
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    await client.close();
  });

  it("refuses define after router() and fetches the metadata once", async () => {
    const h = await listening();
    const mcp = createTereoMcp(h.options());
    mcp.define({
      name: "first",
      description: "d",
      permission: null,
      readOnly: true,
      handler: () => "ok",
    });

    const routers = Promise.all([mcp.router(), mcp.router()]);
    expect(() =>
      mcp.define({
        name: "late",
        description: "d",
        permission: null,
        readOnly: true,
        handler: () => "ok",
      })
    ).toThrow(/cannot be defined/);
    await routers;
    await mcp.router();

    expect(h.metadataHits.count).toBe(1);
  });

  it("rejects router() when a start check fails", async () => {
    const h = await listening();
    const mcp = createTereoMcp(h.options({ allowedClients: [] }));

    await expect(mcp.router()).rejects.toThrow(/allowedClients/);
    expect(h.metadataHits.count).toBe(0);
  });
});
