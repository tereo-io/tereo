import { buildRedisConnection, type RedisEnv } from "./redisEnv.js";
import { redisRetryStrategy } from "./redisRetry.js";
import { logger } from "./logger.js";
import { Redis } from "ioredis";

const LOCK_TTL = 30; // seconds
let LOCK_PREFIX: string | null = null;
let redisClient: Redis | null = null;

/** Redis Sentinel (HA) connection — prod injects this in lieu of a single URL. */
export interface RedisSentinelConfig {
  sentinels: { host: string; port: number }[];
  /** Sentinel master group name. */
  name: string;
  password?: string;
}

/** Either a single-node connection URL (dev/test) or a Sentinel config (prod HA). */
export type RedisConnection = string | RedisSentinelConfig;

/** A service's env, narrowed to what Redis init needs: connection + SERVICE_NAME. */
export type RedisInitEnv = RedisEnv & { SERVICE_NAME: string };

/**
 * Initialize the shared Redis client from a service's env. The connection
 * (single URL or Sentinel HA) is derived via `buildRedisConnection`, and the
 * distributed-lock key prefix defaults to `<SERVICE_NAME>:lock:` — pass
 * `lockPrefix` only to override it.
 */
export const initializeRedis = async (
  env: RedisInitEnv,
  lockPrefix?: string
): Promise<void> => {
  if (redisClient) {
    logger.warn("Redis client already initialized");
    return;
  }
  LOCK_PREFIX = lockPrefix ?? `${env.SERVICE_NAME}:lock:`;

  const connection = buildRedisConnection(env);

  const baseOptions = {
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => redisRetryStrategy(times),
  } as const;

  redisClient =
    typeof connection === "string"
      ? new Redis(connection, baseOptions)
      : new Redis({
          sentinels: connection.sentinels,
          name: connection.name,
          password: connection.password,
          ...baseOptions,
        });

  redisClient.on("error", (err) => {
    logger.error({ err }, "Redis client error");
  });

  redisClient.on("connect", () => {
    logger.info("Redis client connected");
  });

  await redisClient.ping();
  logger.info("Redis client initialized and verified");
};

export const getRedisClient = (): Redis => {
  if (!redisClient) {
    throw new Error(
      "Redis client not initialized. Call initializeRedis() first."
    );
  }
  return redisClient;
};

const QUIT_TIMEOUT_MS = 2_000;

/**
 * Every client here retries forever, so while Redis is unreachable QUIT waits
 * in the offline queue behind any command already there and never returns.
 * Dropping the connection instead also ends the reconnect loop. A QUIT that
 * outlasts the timeout (Redis lost after it was sent) is dropped the same way.
 */
export const closeRedisClient = async (client: Redis): Promise<void> => {
  if (client.status !== "ready") {
    client.disconnect();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), QUIT_TIMEOUT_MS);
  });
  const quit = client.quit().then(
    () => true,
    () => false
  );
  try {
    if (!(await Promise.race([quit, timedOut]))) client.disconnect();
  } finally {
    clearTimeout(timer);
  }
};

export const closeRedisConnection = async (): Promise<void> => {
  if (!redisClient) return;
  await closeRedisClient(redisClient);
  redisClient = null;
  LOCK_PREFIX = null;
};

export const acquireLock = async (key: string): Promise<string | null> => {
  const redis = getRedisClient();
  const lockKey = `${LOCK_PREFIX || ""}${key}`;
  const lockToken = crypto.randomUUID();
  const result = await redis.set(lockKey, lockToken, "EX", LOCK_TTL, "NX");
  return result === "OK" ? lockToken : null;
};

export const releaseLock = async (key: string, token: string) => {
  const redis = getRedisClient();
  const lockKey = `${LOCK_PREFIX || ""}${key}`;

  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  const result = await redis.eval(script, 1, lockKey, token);
  return result === 1;
};
