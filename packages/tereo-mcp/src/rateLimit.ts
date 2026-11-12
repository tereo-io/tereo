import type { Logger } from "pino";
import type {
  RateLimitRedis,
  TereoMcpOptions,
  ToolDefinition,
} from "./types.js";

export type RateLimiter = (
  userId: string
) => Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;

const WINDOW_SECONDS = 60;
const DEFAULT_PER_MINUTE = 120;

export const createRateLimiter =
  (opts: {
    redis: RateLimitRedis;
    service: string;
    perMinute: number;
    logger: Logger;
    // A tool with its own limit; without one the counter is server-wide.
    tool?: string;
  }): RateLimiter =>
  async (userId) => {
    const key = `@tereo-io/mcp:${opts.service}:rl:${userId}${opts.tool ? `:${opts.tool}` : ""}`;
    try {
      const count = await opts.redis.incr(key);
      if (count === 1) {
        await opts.redis.expire(key, WINDOW_SECONDS);
        return { allowed: true };
      }
      // A key the first call failed to expire would otherwise count forever.
      const ttl = await opts.redis.ttl(key);
      if (ttl < 0) await opts.redis.expire(key, WINDOW_SECONDS);
      if (count <= opts.perMinute) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
      };
    } catch (err) {
      opts.logger.error({ err }, "MCP rate limiter unavailable; allowing call");
      return { allowed: true };
    }
  };

// Keyed by tool name; a tool that is not limited has no entry.
export const createLimiters = (
  options: Pick<TereoMcpOptions, "name" | "redis" | "rateLimit">,
  tools: readonly ToolDefinition[],
  logger: Logger
): ReadonlyMap<string, RateLimiter> => {
  const limiters = new Map<string, RateLimiter>();
  const { redis } = options;
  if (!redis) return limiters;
  const serverWide =
    options.rateLimit === false
      ? null
      : createRateLimiter({
          redis,
          service: options.name,
          perMinute: options.rateLimit?.perMinute ?? DEFAULT_PER_MINUTE,
          logger,
        });
  for (const tool of tools) {
    if (tool.rateLimit) {
      limiters.set(
        tool.name,
        createRateLimiter({
          redis,
          service: options.name,
          perMinute: tool.rateLimit.perMinute,
          logger,
          tool: tool.name,
        })
      );
    } else if (tool.rateLimit === undefined && serverWide) {
      limiters.set(tool.name, serverWide);
    }
  }
  return limiters;
};
