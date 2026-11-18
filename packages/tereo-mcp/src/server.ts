import { isZodObject, toJsonSchemaError } from "./zodObject.js";
import { McpServer } from "@modelcontextprotocol/server";
import { anySignal, untilAborted } from "./signals.js";
import type { RateLimiter } from "./rateLimit.js";
import { requestScope } from "./requestScope.js";
import type { AuthContext } from "@tereo-io/sdk";
import { readResource } from "./readResource.js";
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
import type {
  InstructionsContext,
  ResourceDefinition,
  TereoMcpOptions,
  ToolContext,
  ToolDefinition,
} from "./types.js";

export interface ServerDeps {
  options: TereoMcpOptions;
  tools: readonly ToolDefinition[];
  resources?: readonly ResourceDefinition[];
  limiters: ReadonlyMap<string, RateLimiter>;
  // The server-wide limiter, which resource reads count toward.
  serverLimiter?: RateLimiter | null;
  logger: Logger;
  // Aborts when a listen server begins closing; router() has none.
  closing?: AbortSignal;
}

const DEFAULT_MAX_RESULT_BYTES = 1_000_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const NEVER_ABORTED = new AbortController().signal;
const INSTRUCTIONS_TIMEOUT_MS = 2_000;
// The methods whose answer carries the instructions, in either era.
const INSTRUCTIONS_METHODS = ["initialize", "server/discover"];

// A failing or slow function costs the caller the instructions, never the request.
const resolveInstructions = async (
  deps: ServerDeps,
  auth: AuthContext | undefined,
  requestId: string
): Promise<string | undefined> => {
  const { options, logger, closing } = deps;
  const { instructions } = options;
  if (typeof instructions !== "function") return instructions;
  const methods = requestScope.getStore()?.methods ?? [];
  if (!auth || !methods.some((m) => INSTRUCTIONS_METHODS.includes(m))) {
    return undefined;
  }
  const signal = anySignal(
    AbortSignal.timeout(INSTRUCTIONS_TIMEOUT_MS),
    closing
  );
  const ctx: InstructionsContext = {
    auth,
    core: options.core,
    requestId,
    logger: logger.child({ user_id: auth.userId, request_id: requestId }),
    signal,
  };
  try {
    const text: unknown = await untilAborted(() => instructions(ctx), signal);
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(
        "The instructions function did not return a non-empty string"
      );
    }
    return text;
  } catch (err) {
    const fields = { user_id: auth.userId, request_id: requestId, err };
    if (closing?.aborted) {
      logger.warn(fields, "MCP instructions stopped: server closing");
    } else {
      logger.error(fields, "MCP instructions failed");
    }
    return undefined;
  }
};

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
  const { closing } = deps;
  const resources = deps.resources ?? [];
  const auth = authFromInfo(authInfo);
  const requestId = requestScope.getStore()?.requestId ?? randomUUID();
  // Declaring the capability up front answers tools/list with an empty list,
  // rather than "method not found", for a caller who may use no tool.
  const server = new McpServer(
    { name: options.name, version: options.version },
    {
      capabilities: {
        tools: { listChanged: false },
        ...(resources.length > 0 && { resources: { listChanged: false } }),
      },
      instructions: await resolveInstructions(deps, auth, requestId),
    }
  );
  if (!auth) return server;

  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  for (const resource of resources) {
    const { uri, meta } = resource;
    server.registerResource(
      resource.name,
      uri,
      {
        ...(resource.title !== undefined && { title: resource.title }),
        ...(resource.description !== undefined && {
          description: resource.description,
        }),
        mimeType: resource.mimeType,
        ...(meta !== undefined && { _meta: meta }),
      },
      (_uri, sdkCtx) =>
        readResource(
          {
            resource,
            ctx: {
              auth,
              core: options.core,
              requestId,
              logger: logger.child({
                resource: uri,
                user_id: auth.userId,
                request_id: requestId,
              }),
              signal: closing ?? NEVER_ABORTED,
            },
            limiter: deps.serverLimiter ?? null,
            maxResultBytes,
            timeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
            closing,
            logger,
          },
          sdkCtx.mcpReq.signal
        )
    );
  }

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
      ...(tool.ui && {
        _meta: {
          // The flat key is the one older MCP Apps hosts read.
          "ui/resourceUri": tool.ui.resourceUri,
          ui: {
            ...tool.ui,
            ...(tool.ui.visibility && { visibility: [...tool.ui.visibility] }),
          },
        },
      }),
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
