import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export async function connect(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
  });
  const client = new Client({ name: "tereo-mcp-tests", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
