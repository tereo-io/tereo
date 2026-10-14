import type { Redis } from "ioredis";
import { logger } from "./logger.js";
import {
  ScopedCache,
  buildCachePrefix,
  getCacheRedis,
  safeCacheDel,
} from "./cache.js";

/**
 * Cache for the files client, in the Redis passed to `createCoreClient`. Every
 * replica of a service shares the key prefix, so entries are shared too.
 */
const FILE_CACHE_PREFIX = buildCachePrefix("file-sdk");

const BUCKET_INVALIDATE_CHANNEL = "file-service:bucket-invalidate";
const OBJECT_INVALIDATE_CHANNEL = "file-service:object-invalidate";

let subscriber: Redis | null = null;
let subscriberStarted = false;

export class FileCache extends ScopedCache {
  constructor() {
    super(FILE_CACHE_PREFIX);
  }
}

/**
 * Start listening for cross-process bucket invalidations published by
 * core. Safe to call multiple times; does nothing after the first
 * successful call. No-ops if the client has no Redis yet.
 */
export async function startFileServiceCache(): Promise<void> {
  if (subscriberStarted) return;
  try {
    subscriber = getCacheRedis().duplicate();
  } catch {
    return;
  }
  subscriber.on("error", (err) => {
    logger.warn({ err }, "file-sdk cache subscriber error");
  });
  subscriber.on("message", async (channel, message) => {
    try {
      if (channel === BUCKET_INVALIDATE_CHANNEL) {
        await safeCacheDel(`${FILE_CACHE_PREFIX}bucket:${message}`);
        return;
      }
      if (channel === OBJECT_INVALIDATE_CHANNEL) {
        const { bucket, key } = JSON.parse(message) as {
          bucket: string;
          key: string;
        };
        await safeCacheDel(`${FILE_CACHE_PREFIX}object:${bucket}/${key}`);
        return;
      }
    } catch (err) {
      logger.warn(
        {
          channel,
          message,
          err,
        },
        "Failed to drop local file-sdk cache on invalidate"
      );
    }
  });
  await subscriber.subscribe(
    BUCKET_INVALIDATE_CHANNEL,
    OBJECT_INVALIDATE_CHANNEL
  );
  subscriberStarted = true;
}

export async function closeFileServiceCache(): Promise<void> {
  if (!subscriber) return;
  try {
    await subscriber.unsubscribe(
      BUCKET_INVALIDATE_CHANNEL,
      OBJECT_INVALIDATE_CHANNEL
    );
    await subscriber.quit();
  } finally {
    subscriber = null;
    subscriberStarted = false;
  }
}
