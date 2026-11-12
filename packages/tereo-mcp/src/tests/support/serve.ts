import type { TereoMcpOptions, ToolDefinition } from "../../types.js";
import { createTereoMcp } from "../../tereoMcp.js";
import { startStubCore } from "../../testing.js";
import type { Listening } from "../../http.js";
import { fakeCore } from "./fakeCore.js";
import type { Logger } from "pino";
import pino from "pino";

export const tool = (
  name: string,
  handler: ToolDefinition["handler"],
  extra: Partial<ToolDefinition> = {}
): ToolDefinition => ({
  name,
  description: `The ${name} tool`,
  permission: null,
  readOnly: true,
  handler,
  ...extra,
});

// Starts a stub core and a listening server on a loopback port; the caller
// runs the returned cleanups (afterEach) to close both.
export async function serve(
  cleanups: (() => Promise<void>)[],
  extra: Partial<TereoMcpOptions>,
  ...tools: ToolDefinition[]
): Promise<{
  server: Listening;
  lines: Record<string, unknown>[];
  raw: string[];
}> {
  const stub = await startStubCore();
  cleanups.push(() => stub.close());
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = pino(
    { level: "debug" },
    {
      write: (s: string) => {
        raw.push(s);
        lines.push(JSON.parse(s));
      },
    }
  ) as Logger;
  const mcp = createTereoMcp({
    name: "quotes",
    version: "1.0.0",
    core: fakeCore(),
    publicUrl: "https://mcp.example.test",
    allowedClients: ["claude"],
    rateLimit: false,
    coreUrl: stub.coreUrl,
    logger,
    ...extra,
  });
  for (const t of tools) mcp.define(t);
  const server = await mcp.listen(0, "127.0.0.1", { signals: false });
  cleanups.push(() => server.close());
  return { server, lines, raw };
}
