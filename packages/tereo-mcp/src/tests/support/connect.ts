import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

// The client speaks the legacy (2025) protocol unless asked to negotiate,
// which against this server selects the modern (2026-07-28) era.
export async function connect(
  url: string,
  token?: string,
  opts: { era?: "legacy" | "modern" } = {}
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined,
  });
  const client = new Client(
    { name: "tereo-mcp-tests", version: "0.0.0" },
    opts.era === "modern" ? { versionNegotiation: { mode: "auto" } } : undefined
  );
  await client.connect(transport);
  return client;
}
