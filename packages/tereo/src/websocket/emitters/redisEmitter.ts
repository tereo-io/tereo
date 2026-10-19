import { createRedis, redisKey } from "../../utils/redis.js";
import { Emitter } from "@socket.io/redis-emitter";
import { logger } from "../../utils/logger.js";
import { Redis } from "ioredis";

let client: Redis | null = null;
let emitter: Emitter | null = null;

/**
 * For a process with no socket.io server (the CLI): broadcasts go through
 * Redis to the servers' adapter, which delivers them to connected sockets.
 * Failures are logged, not thrown — what the broadcast announces has already
 * been committed.
 */
export const getRedisEmitter = (): Emitter => {
  if (emitter) return emitter;
  const redis = createRedis({ maxRetriesPerRequest: 3 });
  redis.on("error", (err) => {
    logger.warn({ err }, "Redis emitter client error");
  });
  // The emitter does not await or catch its publishes.
  const publish = redis.publish.bind(redis) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  (redis as unknown as { publish: typeof publish }).publish = (...args) =>
    publish(...args).catch((err: unknown) => {
      logger.warn({ err }, "Redis emitter publish failed");
      return 0;
    });
  client = redis;
  emitter = new Emitter(redis, { key: redisKey("socket.io") });
  return emitter;
};

/** Flushes what was published and closes the client, if one was opened. */
export const closeRedisEmitter = async (): Promise<void> => {
  const redis = client;
  client = null;
  emitter = null;
  if (!redis) return;
  await redis.quit().catch(() => redis.disconnect());
};
