import { createServer, type Server as HttpServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { connect } from "./support/connect.js";
import type { RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  type OAuthTokenVerifier,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import {
  type AuthInfo,
  createMcpHandler,
  McpServer,
  type McpRequestContext,
  type McpServerFactory,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";

const TOKEN = "contract-token";

const issued: AuthInfo = {
  token: TOKEN,
  clientId: "contract-client",
  scopes: ["mcp"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    if (token !== TOKEN) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown token");
    }
    return issued;
  },
};

interface Harness {
  base: string;
  mcpUrl: string;
}

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

async function start(
  factory: McpServerFactory,
  before?: RequestHandler
): Promise<Harness> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const mcpUrl = `${base}/mcp`;

  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/oauth/authorize",
        token_endpoint: "https://auth.example.test/oauth/token",
        response_types_supported: ["code"],
      },
      resourceServerUrl: new URL(mcpUrl),
    })
  );
  if (before) app.use(before);
  const auth = requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(mcpUrl)),
  });
  const node = toNodeHandler(createMcpHandler(factory));
  app.all("/mcp", auth, (req, res) => void node(req, res, req.body));
  server.on("request", app);
  return { base, mcpUrl };
}

function emptyServer(): McpServer {
  return new McpServer({ name: "contract", version: "0.0.0" });
}

describe("MCP SDK contract", () => {
  it("runs the factory once per request and gives it the verifier's auth info", async () => {
    const contexts: McpRequestContext[] = [];
    const { mcpUrl } = await start((ctx) => {
      contexts.push(ctx);
      const server = emptyServer();
      server.registerTool("ping", {}, () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      return server;
    });
    const client = await connect(mcpUrl, TOKEN);

    const before = contexts.length;
    await client.callTool({ name: "ping" });
    await client.callTool({ name: "ping" });

    expect(contexts.length - before).toBe(2);
    const last = contexts[contexts.length - 1];
    expect(last.authInfo?.token).toBe(issued.token);
    expect(last.authInfo?.clientId).toBe(issued.clientId);
    await client.close();
  });

  it("passes the handler its context after the parsed input", async () => {
    let withInput: unknown[] = [];
    let withoutInput: unknown[] = [];
    const { mcpUrl } = await start(() => {
      const server = emptyServer();
      server.registerTool(
        "echo",
        { inputSchema: z.object({ text: z.string() }) },
        (...received: unknown[]) => {
          withInput = received;
          return { content: [{ type: "text", text: "ok" }] };
        }
      );
      server.registerTool("bare", {}, (...received: unknown[]) => {
        withoutInput = received;
        return { content: [{ type: "text", text: "ok" }] };
      });
      return server;
    });
    const client = await connect(mcpUrl, TOKEN);

    await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.callTool({ name: "bare" });

    expect(withInput[0]).toEqual({ text: "hi" });
    const ctx = withInput[1] as { http?: { authInfo?: AuthInfo } };
    expect(ctx.http?.authInfo?.token).toBe(TOKEN);
    const bareCtx = withoutInput[0] as { http?: { authInfo?: AuthInfo } };
    expect(bareCtx.http?.authInfo?.token).toBe(TOKEN);
    await client.close();
  });

  it("answers a missing token with 401 and a resource_metadata challenge", async () => {
    const { mcpUrl } = await start(emptyServer);

    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="'
    );
  });

  it("serves the protected resource metadata", async () => {
    const { base } = await start(emptyServer);

    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { authorization_servers?: unknown };
    expect(body.authorization_servers).toEqual(
      expect.arrayContaining([expect.any(String)])
    );
  });

  it("turns a thrown handler error into an isError result carrying its message", async () => {
    const { mcpUrl } = await start(() => {
      const server = emptyServer();
      server.registerTool("explode", {}, () => {
        throw new Error("contract failure detail");
      });
      return server;
    });
    const client = await connect(mcpUrl, TOKEN);

    const result = await client.callTool({ name: "explode" });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("contract failure detail");
    await client.close();
  });

  it("keeps an AsyncLocalStorage store from Express middleware through to the factory", async () => {
    const storage = new AsyncLocalStorage<{ marker: string }>();
    const seen: Array<{ marker: string } | undefined> = [];
    const { mcpUrl } = await start(
      () => {
        seen.push(storage.getStore());
        const server = emptyServer();
        server.registerTool("ping", {}, () => ({
          content: [{ type: "text", text: "pong" }],
        }));
        return server;
      },
      (_req, _res, next) => storage.run({ marker: "from-middleware" }, next)
    );
    const client = await connect(mcpUrl, TOKEN);

    await client.callTool({ name: "ping" });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual({ marker: "from-middleware" });
    await client.close();
  });
});
