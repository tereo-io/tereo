import type { RedisConnection } from "./redis.js";
import { z } from "zod";

/**
 * Shared Redis env contract — accepts EITHER a single connection URL
 * (`REDIS_URL` — dev/test/single-node) OR a Sentinel config (`REDIS_SENTINELS` +
 * `REDIS_MASTER_NAME` [+ `REDIS_PASSWORD`] — prod HA).
 */
export const redisEnvFields = () => ({
  REDIS_URL: z.string().optional(),
  /** Comma-separated `host:port` list (port defaults to 26379). */
  REDIS_SENTINELS: z.string().optional(),
  /** Sentinel master group name. */
  REDIS_MASTER_NAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
});

export interface RedisEnv {
  REDIS_URL?: string;
  REDIS_SENTINELS?: string;
  REDIS_MASTER_NAME?: string;
  REDIS_PASSWORD?: string;
}

/** Sentinel needs both the host list and the master name to be usable. */
const hasSentinel = (env: RedisEnv): boolean =>
  !!env.REDIS_SENTINELS && !!env.REDIS_MASTER_NAME;

/**
 * Require at least one valid Redis connection. Add to a service's `.superRefine`.
 * Fails loud (no silent default) when neither is configured — consistent with the
 * resolver omitting `REDIS_URL` in prod so a missing injection errors at boot.
 */
export const refineRedisEnv = (env: RedisEnv, ctx: z.RefinementCtx): void => {
  if (!env.REDIS_URL && !hasSentinel(env)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Redis not configured: set REDIS_URL, or REDIS_SENTINELS + REDIS_MASTER_NAME (Sentinel HA).",
    });
  }
};

/** Parse `"host:26379,host2:26379"` → `[{host,port}]` (default Sentinel port 26379). */
export const parseSentinels = (raw: string): { host: string; port: number }[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, port] = entry.split(":");
      return { host, port: port ? Number(port) : 26379 };
    });

// Assumes refineRedisEnv has already passed.
export const buildRedisConnection = (env: RedisEnv): RedisConnection => {
  if (hasSentinel(env)) {
    return {
      sentinels: parseSentinels(env.REDIS_SENTINELS as string),
      name: env.REDIS_MASTER_NAME as string,
      password: env.REDIS_PASSWORD,
    };
  }
  // refineRedisEnv guarantees REDIS_URL is present here.
  return env.REDIS_URL as string;
};
