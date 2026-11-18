import type { ResourceDefinition, ToolContext } from "./types.js";
import { anySignal, untilAborted } from "./signals.js";
import type { RateLimiter } from "./rateLimit.js";
import type { Logger } from "pino";

export type ResourceContents = {
  uri: string;
  mimeType: string;
  _meta?: Record<string, unknown>;
} & ({ text: string } | { blob: string });

// An error whose message is written for the client.
class ResourceRefusal extends Error {}

const bodyOf = (
  uri: string,
  value: unknown
): { text: string } | { blob: string } => {
  const body = (value ?? {}) as { text?: unknown; blob?: unknown };
  if (typeof body.text === "string") return { text: body.text };
  if (typeof body.blob === "string") return { blob: body.blob };
  throw new Error(
    `The read function of resource "${uri}" did not return { text } or { blob } holding a string`
  );
};

// Bounded as a tool call is: the server-wide rate limit, a timeout and a size
// cap. A failure is logged here; the client gets a message with no detail.
export const readResource = async (
  deps: {
    resource: ResourceDefinition;
    // Its signal is replaced by this read's own.
    ctx: ToolContext;
    limiter: RateLimiter | null;
    maxResultBytes: number;
    timeoutMs: number;
    // Aborts when a listen server begins closing.
    closing?: AbortSignal;
    logger: Logger;
  },
  // The MCP SDK's per-request signal: a disconnect or a cancel.
  requestSignal?: AbortSignal
): Promise<{ contents: ResourceContents[] }> => {
  const { resource, ctx, limiter, maxResultBytes, timeoutMs, logger } = deps;
  const { uri, meta } = resource;
  const fields = {
    resource: uri,
    user_id: ctx.auth.userId,
    request_id: ctx.requestId,
  };

  if (limiter) {
    const verdict = await limiter(ctx.auth.userId);
    if (!verdict.allowed) {
      logger.info(fields, "MCP resource read rate limited");
      throw new ResourceRefusal(
        `Rate limit reached; retry in ${verdict.retryAfterSeconds} seconds`
      );
    }
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const cancelled = anySignal(requestSignal, deps.closing);
  const signal = anySignal(timeout, cancelled);
  try {
    const body = bodyOf(
      uri,
      await untilAborted(() => resource.read({ ...ctx, signal }), signal)
    );
    const bytes = Buffer.byteLength(
      "text" in body ? body.text : body.blob,
      "utf8"
    );
    if (bytes > maxResultBytes) {
      throw new ResourceRefusal(
        `Resource too large (${bytes} bytes; limit ${maxResultBytes})`
      );
    }
    return {
      contents: [
        {
          uri,
          mimeType: resource.mimeType,
          ...body,
          ...(meta !== undefined && { _meta: meta }),
        },
      ],
    };
  } catch (err) {
    if (cancelled.aborted) {
      logger.info(fields, "MCP resource read cancelled");
    } else if (timeout.aborted) {
      logger.warn(
        { ...fields, timeout_ms: timeoutMs },
        "MCP resource read timed out"
      );
    } else if (err instanceof ResourceRefusal) {
      logger.warn(
        { ...fields, reason: err.message },
        "MCP resource read refused"
      );
      throw err;
    } else {
      logger.error({ ...fields, err }, "MCP resource read failed");
    }
    // The SDK sends the message to the client; keep error text out of it.
    throw new Error("The resource could not be read", { cause: err });
  }
};
