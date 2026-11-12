import type { TereoMcpOptions, ToolContext, ToolDefinition } from "./types.js";
import { isZodObject, toJsonSchemaError } from "./zodObject.js";
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
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";

export interface ServerDeps {
  options: TereoMcpOptions;
  tools: readonly ToolDefinition[];
  limiters: ReadonlyMap<string, RateLimiter>;
  logger: Logger;
  // Aborts when a listen server begins closing; router() has none.
  closing?: AbortSignal;
}

const DEFAULT_MAX_RESULT_BYTES = 1_000_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const NEVER_ABORTED = new AbortController().signal;

const annotationsOf = (tool: ToolDefinition): ToolAnnotations => ({
  readOnlyHint: tool.readOnly,
  ...(tool.destructive !== undefined && { destructiveHint: tool.destructive }),
  ...(tool.idempotent !== undefined && { idempotentHint: tool.idempotent }),
});

export const buildServer = async (
  deps: ServerDeps,
  authInfo: AuthInfo | undefined
): Promise<McpServer> => {
  const { options, logger, limiters } = deps;
  // Declaring the capability up front answers tools/list with an empty list,
  // rather than "method not found", for a caller who may use no tool.
  const server = new McpServer(
    { name: options.name, version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: options.instructions,
    }
  );
  const auth = authFromInfo(authInfo);
  if (!auth) return server;

  const requestId = requestScope.getStore()?.requestId ?? randomUUID();
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const { closing } = deps;
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
        // runTool gives each call its own; an input function sees this one.
        signal: closing ?? NEVER_ABORTED,
      };
      if (typeof tool.input !== "function") {
        return { tool, ctx, schema: tool.input };
      }
      try {
        const schema: unknown = await tool.input(ctx);
        if (!isZodObject(schema)) {
          throw new Error(
            `The input function of tool "${tool.name}" did not return a z.object() schema`
          );
        }
        if (toJsonSchemaError(schema, "input") !== undefined) {
          throw new Error(
            `The input function of tool "${tool.name}" returned a schema that cannot be expressed as JSON Schema`
          );
        }
        return { tool, ctx, schema };
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
    const limiter = limiters.get(tool.name) ?? null;
    const timeoutMs =
      tool.timeoutMs ?? options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const run = async (
      input: unknown,
      sdkCtx: ServerContext
    ): Promise<CallToolResult> => ({
      ...(await runTool(
        { tool, ctx, limiter, maxResultBytes, timeoutMs, closing, logger },
        input,
        sdkCtx.mcpReq.signal
      )),
    });
    const config = {
      ...(tool.title !== undefined && { title: tool.title }),
      description: tool.description,
      annotations: annotationsOf(tool),
      ...(tool.output && { outputSchema: tool.output }),
    };
    if (schema) {
      server.registerTool(
        tool.name,
        { ...config, inputSchema: schema },
        (args, sdkCtx) => run(args, sdkCtx)
      );
    } else {
      // Without an input schema the SDK passes the context as the only
      // argument, so the tool's input is undefined rather than that context.
      server.registerTool(tool.name, config, (sdkCtx) =>
        run(undefined, sdkCtx)
      );
    }
  }
  return server;
};
