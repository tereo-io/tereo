import type { ToolContext, ToolDefinition } from "./types.js";
import type { RateLimiter } from "./rateLimit.js";
import { describePath } from "./zodObject.js";
import { HttpError } from "@tereo-io/sdk";
import { ToolError } from "./errors.js";
import type { Logger } from "pino";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
}

type Outcome =
  | "ok"
  | "tool_error"
  | "rate_limited"
  | "internal_error"
  | "timeout"
  | "cancelled";

const TIMED_OUT = Symbol("timed out");

const text = (value: string, isError?: true): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError } : {}),
});

const timedOutText = (timeoutMs: number) =>
  `Tool timed out after ${timeoutMs} ms`;

// Paths and issue codes only: an issue's message may quote the result.
const outputMismatch = (
  toolName: string,
  schema: unknown,
  problem: string,
  issues: readonly { path: readonly PropertyKey[]; code: string }[]
): Error =>
  new Error(
    `Tool "${toolName}" ${problem}: ${issues
      .map((issue) => `${describePath(schema, issue.path)} (${issue.code})`)
      .join(", ")}`
  );

export const runTool = async (
  deps: {
    tool: ToolDefinition;
    ctx: ToolContext;
    limiter: RateLimiter | null;
    maxResultBytes: number;
    timeoutMs: number;
    // Aborts when a listen server begins closing.
    closing?: AbortSignal;
    // Not ctx.logger, whose bindings would repeat this line's own fields.
    logger: Logger;
  },
  input: unknown,
  // The MCP SDK's per-request signal: a disconnect, or a 2026-era client's cancel.
  requestSignal?: AbortSignal
): Promise<ToolResult> => {
  const { tool, ctx, limiter, maxResultBytes, timeoutMs, logger } = deps;
  const started = process.hrtime.bigint();
  const state: { outcome: Outcome; failure?: unknown } = { outcome: "ok" };

  const controller = new AbortController();
  const callCtx: ToolContext = { ...ctx, signal: controller.signal };
  const sources = [deps.closing, requestSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  const forwards = sources.map((source) => {
    const forward = () => controller.abort(source.reason);
    if (source.aborted) forward();
    else source.addEventListener("abort", forward, { once: true });
    return () => source.removeEventListener("abort", forward);
  });

  const call = async (): Promise<unknown> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const pending = Promise.resolve().then(() => tool.handler(input, callCtx));
    try {
      const settled = await Promise.race([pending, timedOut]);
      if (settled === TIMED_OUT) {
        // Whatever the handler settles with later is discarded, unlogged.
        pending.catch(() => undefined);
        controller.abort(
          new DOMException(timedOutText(timeoutMs), "TimeoutError")
        );
      }
      return settled;
    } finally {
      clearTimeout(timer);
    }
  };

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
      const result = await call();
      if (result === TIMED_OUT) {
        state.outcome = "timeout";
        return text(timedOutText(timeoutMs), true);
      }
      let structured: Record<string, unknown> | undefined;
      if (tool.output) {
        const parsed = await tool.output.safeParseAsync(result);
        if (!parsed.success) {
          return internal(
            outputMismatch(
              tool.name,
              tool.output,
              "returned a result that does not match its output schema",
              parsed.error.issues
            )
          );
        }
        // The SDK validates structuredContent against the same schema and
        // answers a failure with its own message, which may quote values.
        const again = await tool.output.safeParseAsync(parsed.data);
        if (!again.success) {
          return internal(
            outputMismatch(
              tool.name,
              tool.output,
              "has an output schema that refuses its own parsed result",
              again.error.issues
            )
          );
        }
        structured = parsed.data;
      }
      const value = structured ?? result;
      // JSON.stringify returns undefined for undefined, functions and symbols
      const body =
        typeof value === "string" ? value : (JSON.stringify(value) ?? "");
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > maxResultBytes) {
        state.outcome = "tool_error";
        return text(
          `Result too large (${bytes} bytes; limit ${maxResultBytes})`,
          true
        );
      }
      return structured
        ? { ...text(body), structuredContent: structured }
        : text(body);
    } catch (err) {
      // A timeout never gets here: its call has already answered.
      const { signal } = controller;
      if (
        signal.aborted &&
        (err === signal.reason ||
          (err as { name?: unknown } | null)?.name === "AbortError")
      ) {
        state.outcome = "cancelled";
        return text("Tool call cancelled", true);
      }
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
  } finally {
    for (const remove of forwards) remove();
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
    logger.error({ ...fields, err: state.failure }, "MCP tool call");
  } else if (state.outcome === "timeout") {
    logger.warn(fields, "MCP tool call");
  } else {
    logger.info(fields, "MCP tool call");
  }
  return result;
};
