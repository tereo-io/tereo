import type { RedisOptions } from "ioredis";
import { z } from "zod";

/**
 * Either `REDIS_URL` (single node) or Sentinel (`REDIS_SENTINELS` +
 * `REDIS_MASTER_NAME` [+ `REDIS_PASSWORD`]).
 */
export const redisEnvFields = () => ({
  REDIS_URL: z.string().optional(),
  /** Comma-separated `host:port` list (port defaults to 26379). */
  REDIS_SENTINELS: z.string().optional(),
  REDIS_MASTER_NAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  // Overrides a database index in REDIS_URL's path.
  REDIS_DB: z.coerce.number().int().min(0).max(15).optional(),
  // Prepended to every key, channel and BullMQ prefix core uses.
  REDIS_KEY_PREFIX: z
    .string()
    .max(64)
    .regex(
      /^[A-Za-z0-9:_.-]*$/,
      "REDIS_KEY_PREFIX may contain only letters, digits and : _ . -"
    )
    .default(""),
});

export interface RedisEnv {
  REDIS_URL?: string;
  REDIS_SENTINELS?: string;
  REDIS_MASTER_NAME?: string;
  REDIS_PASSWORD?: string;
  REDIS_DB?: number;
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

export interface RedisConnection {
  /** Set in single-node mode; absent with Sentinel. */
  url?: string;
  options: Pick<RedisOptions, "sentinels" | "name" | "password" | "db">;
}

// Assumes refineRedisEnv has already passed.
export const buildRedisConnection = (env: RedisEnv): RedisConnection => {
  if (hasSentinel(env)) {
    return {
      options: {
        sentinels: parseSentinels(env.REDIS_SENTINELS as string),
        name: env.REDIS_MASTER_NAME as string,
        password: env.REDIS_PASSWORD,
        ...(env.REDIS_DB === undefined ? {} : { db: env.REDIS_DB }),
      },
    };
  }
  const url = env.REDIS_URL as string;
  if (env.REDIS_DB === undefined) return { url, options: {} };
  // ioredis also takes a unix socket path, which has no database to rewrite.
  if (!/^rediss?:\/\//i.test(url))
    return { url, options: { db: env.REDIS_DB } };
  // ioredis prefers the URL's path to a `db` option, so rewrite the path.
  const withDb = new URL(url);
  withDb.pathname = `/${env.REDIS_DB}`;
  return { url: withDb.toString(), options: {} };
};
