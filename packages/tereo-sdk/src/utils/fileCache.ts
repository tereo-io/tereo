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

export interface FileServiceCacheOptions {
  /** Core's `REDIS_KEY_PREFIX`, which core puts in front of its channel names. */
  channelPrefix?: string;
}

let bucketChannel = BUCKET_INVALIDATE_CHANNEL;
let objectChannel = OBJECT_INVALIDATE_CHANNEL;

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
export async function startFileServiceCache(
  options: FileServiceCacheOptions = {}
): Promise<void> {
  if (subscriberStarted) return;
  const prefix = options.channelPrefix ?? "";
  bucketChannel = `${prefix}${BUCKET_INVALIDATE_CHANNEL}`;
  objectChannel = `${prefix}${OBJECT_INVALIDATE_CHANNEL}`;
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
      if (channel === bucketChannel) {
        await safeCacheDel(`${FILE_CACHE_PREFIX}bucket:${message}`);
        return;
      }
      if (channel === objectChannel) {
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
  await subscriber.subscribe(bucketChannel, objectChannel);
  subscriberStarted = true;
}

export async function closeFileServiceCache(): Promise<void> {
  if (!subscriber) return;
  try {
    await subscriber.unsubscribe(bucketChannel, objectChannel);
    await subscriber.quit();
  } finally {
    subscriber = null;
    subscriberStarted = false;
  }
}
