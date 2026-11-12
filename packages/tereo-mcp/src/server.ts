import type { TereoMcpOptions, ToolContext, ToolDefinition } from "./types.js";
import { McpServer } from "@modelcontextprotocol/server";
import type { RateLimiter } from "./rateLimit.js";
import { requestScope } from "./requestScope.js";
import { hasPermission } from "@tereo-io/sdk";
import { authFromInfo } from "./verifier.js";
import { randomUUID } from "node:crypto";
import { runTool } from "./runTool.js";
import type { Logger } from "pino";
import type {
  AuthInfo,
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/server";

export interface ServerDeps {
  options: TereoMcpOptions;
  tools: readonly ToolDefinition[];
  limiter: RateLimiter | null;
  logger: Logger;
}

const DEFAULT_MAX_RESULT_BYTES = 1_000_000;

const annotationsOf = (tool: ToolDefinition): ToolAnnotations => ({
  readOnlyHint: tool.readOnly,
  ...(tool.destructive !== undefined && { destructiveHint: tool.destructive }),
  ...(tool.idempotent !== undefined && { idempotentHint: tool.idempotent }),
});

export const buildServer = async (
  deps: ServerDeps,
  authInfo: AuthInfo | undefined
): Promise<McpServer> => {
  const { options, logger, limiter } = deps;
  // Declaring the capability up front answers tools/list with an empty list,
  // rather than "method not found", for a caller who may use no tool.
  const server = new McpServer(
    { name: options.name, version: options.version },
    { capabilities: { tools: { listChanged: false } } }
  );
  const auth = authFromInfo(authInfo);
  if (!auth) return server;

  const requestId = requestScope.getStore()?.requestId ?? randomUUID();
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const visible = deps.tools.filter(
    (tool) =>
      tool.permission === null ||
      hasPermission(auth.permissions, tool.permission)
  );

  const prepared = await Promise.all(
    visible.map(async (tool) => {
      const ctx: ToolContext = {
        auth,
        core: options.core,
        requestId,
        logger: logger.child({
          tool: tool.name,
          user_id: auth.userId,
          request_id: requestId,
        }),
      };
      if (typeof tool.input !== "function") {
        return { tool, ctx, schema: tool.input };
      }
      try {
        return { tool, ctx, schema: await tool.input(ctx) };
      } catch (err) {
        logger.error(
          { tool: tool.name, user_id: auth.userId, err },
          "MCP tool input schema failed"
        );
        return null;
      }
    })
  );

  for (const entry of prepared) {
    if (!entry) continue;
    const { tool, ctx, schema } = entry;
    // ToolResult is an interface, which lacks the index signature
    // CallToolResult carries; a spread copy has it implicitly.
    const run = async (input: unknown): Promise<CallToolResult> => ({
      ...(await runTool({ tool, ctx, limiter, maxResultBytes }, input)),
    });
    const config = {
      description: tool.description,
      annotations: annotationsOf(tool),
    };
    if (schema) {
      server.registerTool(
        tool.name,
        { ...config, inputSchema: schema },
        (args) => run(args)
      );
    } else {
      // Without an input schema the SDK passes the context as the only
      // argument, so the tool's input is undefined rather than that context.
      server.registerTool(tool.name, config, () => run(undefined));
    }
  }
  return server;
};
