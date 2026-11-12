import type { TereoMcp } from "./tereoMcp.js";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export async function startStubCore(): Promise<{
  coreUrl: string;
  close(): Promise<void>;
}> {
  let issuer = "";
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    if (
      req.method !== "GET" ||
      path !== "/.well-known/oauth-authorization-server"
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        response_types_supported: ["code"],
      })
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The MCP SDK accepts a plain-http issuer only on localhost or 127.0.0.1.
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let closing: Promise<void> | undefined;
  return {
    coreUrl: issuer,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
      })),
  };
}

export async function createTestClient(
  mcp: TereoMcp,
  opts: { token: string }
): Promise<{ client: Client; close(): Promise<void> }> {
  const server = await mcp.listen(0, "127.0.0.1");
  const client = new Client({
    name: "tereo-mcp-test-client",
    version: "0.0.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
      })
    );
  } catch (err) {
    await server.close();
    throw err;
  }
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
