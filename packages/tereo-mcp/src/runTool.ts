import type { ToolContext, ToolDefinition } from "./types.js";
import type { RateLimiter } from "./rateLimit.js";
import { HttpError } from "@tereo-io/sdk";
import { ToolError } from "./errors.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

type Outcome = "ok" | "tool_error" | "rate_limited" | "internal_error";

const text = (value: string, isError?: true): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError } : {}),
});

export const runTool = async (
  deps: {
    tool: ToolDefinition;
    ctx: ToolContext;
    limiter: RateLimiter | null;
    maxResultBytes: number;
  },
  input: unknown
): Promise<ToolResult> => {
  const { tool, ctx, limiter, maxResultBytes } = deps;
  const started = process.hrtime.bigint();
  const state: { outcome: Outcome; failure?: unknown } = { outcome: "ok" };

  const run = async (): Promise<ToolResult> => {
    if (limiter) {
      const verdict = await limiter(ctx.auth.userId);
      if (!verdict.allowed) {
        state.outcome = "rate_limited";
        return text(
          `Rate limit reached; retry in ${verdict.retryAfterSeconds} seconds`,
          true
        );
      }
    }
    try {
      const result = await tool.handler(input, ctx);
      // JSON.stringify returns undefined for undefined, functions and symbols
      const body =
        typeof result === "string" ? result : (JSON.stringify(result) ?? "");
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > maxResultBytes) {
        state.outcome = "tool_error";
        return text(
          `Result too large (${bytes} bytes; limit ${maxResultBytes})`,
          true
        );
      }
      return text(body);
    } catch (err) {
      if (
        err instanceof ToolError ||
        (err instanceof HttpError &&
          err.statusCode >= 400 &&
          err.statusCode < 500)
      ) {
        state.outcome = "tool_error";
        return text(err.message, true);
      }
      return internal(err);
    }
  };

  const internal = (err: unknown): ToolResult => {
    state.outcome = "internal_error";
    state.failure = err;
    return text(`Internal error (request ${ctx.requestId})`, true);
  };

  let result: ToolResult;
  try {
    result = await run();
  } catch (err) {
    result = internal(err);
  }

  const fields = {
    tool: tool.name,
    user_id: ctx.auth.userId,
    client_id: ctx.auth.clientId,
    org_id: ctx.auth.organizationId,
    request_id: ctx.requestId,
    outcome: state.outcome,
    duration_ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
  };
  if (state.outcome === "internal_error") {
    ctx.logger.error({ ...fields, err: state.failure }, "MCP tool call");
  } else {
    ctx.logger.info(fields, "MCP tool call");
  }
  return result;
};
