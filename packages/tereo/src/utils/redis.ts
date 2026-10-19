import { buildRedisConnection, type RedisEnv } from "./redisEnv.js";
import { redisRetryStrategy } from "./redisRetry.js";
import { Redis, type RedisOptions } from "ioredis";
import { logger } from "./logger.js";
import env from "../env.js";

const LOCK_TTL = 30; // seconds
let LOCK_PREFIX: string | null = null;
let redisClient: Redis | null = null;

/** A service's env, narrowed to what Redis init needs: connection, key prefix and SERVICE_NAME. */
export type RedisInitEnv = RedisEnv & {
  SERVICE_NAME: string;
  REDIS_KEY_PREFIX: string;
};

/**
 * Every key and channel core uses goes through here, so `REDIS_KEY_PREFIX`
 * lets several deployments share one Redis database.
 */
export const redisKey = (...parts: string[]): string =>
  `${env.REDIS_KEY_PREFIX}${parts.join(":")}`;

export const createRedis = (
  options: RedisOptions = {},
  redisEnv: RedisEnv = env
): Redis => {
  const { url, options: connection } = buildRedisConnection(redisEnv);
  return url
    ? new Redis(url, { ...connection, ...options })
    : new Redis({ ...connection, ...options });
};

/**
 * The distributed-lock prefix defaults to `<REDIS_KEY_PREFIX><SERVICE_NAME>:lock:`,
 * both from `initEnv`, the env the connection comes from.
 */
export const initializeRedis = async (
  initEnv: RedisInitEnv,
  lockPrefix?: string
): Promise<void> => {
  if (redisClient) {
    logger.warn("Redis client already initialized");
    return;
  }
  LOCK_PREFIX =
    lockPrefix ?? `${initEnv.REDIS_KEY_PREFIX}${initEnv.SERVICE_NAME}:lock:`;

  redisClient = createRedis(
    {
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => redisRetryStrategy(times),
    },
    initEnv
  );

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
