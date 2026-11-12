import type { TereoMcp } from "./tereoMcp.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

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
