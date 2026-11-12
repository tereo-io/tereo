import type { RateLimitRedis } from "./types.js";
import type { Logger } from "pino";

export type RateLimiter = (
  userId: string
) => Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;

const WINDOW_SECONDS = 60;

export const createRateLimiter =
  (opts: {
    redis: RateLimitRedis;
    service: string;
    perMinute: number;
    logger: Logger;
  }): RateLimiter =>
  async (userId) => {
    const key = `@tereo-io/mcp:${opts.service}:rl:${userId}`;
    try {
      const count = await opts.redis.incr(key);
      if (count === 1) await opts.redis.expire(key, WINDOW_SECONDS);
      if (count <= opts.perMinute) return { allowed: true };
      const ttl = await opts.redis.ttl(key);
      return {
        allowed: false,
        retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
      };
    } catch (err) {
      opts.logger.error({ err }, "MCP rate limiter unavailable; allowing call");
      return { allowed: true };
    }
  };
