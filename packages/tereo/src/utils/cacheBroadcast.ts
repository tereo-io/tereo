import { closeRedisClient, getRedisClient, redisKey } from "./redis.js";
import { logger } from "./logger.js";
import { Redis } from "ioredis";

// The SDK's file cache subscribes to the first two; its `channelPrefix` option
// must equal REDIS_KEY_PREFIX.
const BUCKET_INVALIDATE_CHANNEL = redisKey("file-service:bucket-invalidate");
const OBJECT_INVALIDATE_CHANNEL = redisKey("file-service:object-invalidate");
const IDENTITY_PROVIDER_INVALIDATE_CHANNEL = redisKey(
  "auth:identity-provider-invalidate"
);

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
const subscribers: Array<(bucketName: string) => void> = [];
const identityProviderSubscribers: Array<(id: string) => void> = [];
const listenersByChannel: Record<string, Array<(message: string) => void>> = {
  [BUCKET_INVALIDATE_CHANNEL]: subscribers,
  [IDENTITY_PROVIDER_INVALIDATE_CHANNEL]: identityProviderSubscribers,
};

/**
 * Lazily construct a dedicated publisher connection. The connection retries
 * forever, so `end` only follows a close; null it out then so the next call
 * re-duplicates a fresh one instead of reusing the closed socket.
 */
function getPublisher(): Redis {
  if (!publisher) {
    const fresh = getRedisClient().duplicate();
    fresh.on("error", (err) => {
      logger.warn({ err }, "cacheBroadcast publisher error");
    });
    fresh.on("end", () => {
      if (publisher === fresh) publisher = null;
    });
    publisher = fresh;
  }
  return publisher;
}

/**
 * Publish an invalidation message so SDK consumers fleet-wide can drop their
 * cached bucket metadata. Fire-and-forget; errors are logged but not thrown —
 * cache staleness is not worth failing a mutation.
 */
export async function broadcastBucketInvalidate(
  bucketName: string
): Promise<void> {
  try {
    await getPublisher().publish(BUCKET_INVALIDATE_CHANNEL, bucketName);
  } catch (error) {
    logger.warn(
      {
        bucketName,
        err: error,
      },
      "Failed to broadcast bucket invalidation"
    );
  }
}

/**
 * Register a listener that is invoked whenever an invalidation message arrives
 * on the bucket channel. Middlewares (CORS, rate-limit) that cache bucket
 * metadata in-process should register here so a mutation anywhere in the
 * fleet drops the local cache promptly.
 */
export function onBucketInvalidate(
  listener: (bucketName: string) => void
): void {
  subscribers.push(listener);
}

/**
 * Publish an invalidation message so SDK consumers fleet-wide can drop their
 * cached per-object metadata. Fire-and-forget; errors are logged but not
 * thrown — cache staleness is not worth failing a mutation.
 */
export async function broadcastObjectInvalidate(
  bucket: string,
  key: string
): Promise<void> {
  try {
    await getPublisher().publish(
      OBJECT_INVALIDATE_CHANNEL,
      JSON.stringify({ bucket, key })
    );
  } catch (error) {
    logger.warn(
      {
        bucket,
        key,
        err: error,
      },
      "Failed to broadcast object invalidation"
    );
  }
}

/** Drops every process's cached discovery for the provider. Fire-and-forget. */
export async function broadcastIdentityProviderInvalidate(
  id: string
): Promise<void> {
  try {
    await getPublisher().publish(IDENTITY_PROVIDER_INVALIDATE_CHANNEL, id);
  } catch (err) {
    logger.warn(
      { err, identityProviderId: id },
      "Failed to broadcast identity provider invalidation"
    );
  }
}

export function onIdentityProviderInvalidate(
  listener: (id: string) => void
): void {
  identityProviderSubscribers.push(listener);
}

/** Safe to call more than once: a no-op until `closeCacheBroadcast`. */
export async function startCacheSubscriber(): Promise<void> {
  if (subscriber) return;
  const fresh = getRedisClient().duplicate();
  fresh.on("error", (err) => {
    logger.warn({ err }, "cacheBroadcast subscriber error");
  });
  fresh.on("end", () => {
    if (subscriber === fresh) subscriber = null;
  });
  fresh.on("message", (channel, message) => {
    for (const l of listenersByChannel[channel] ?? []) {
      try {
        l(message);
      } catch (err) {
        logger.warn(
          {
            err,
          },
          "cacheBroadcast listener threw"
        );
      }
    }
  });
  await fresh.subscribe(...Object.keys(listenersByChannel));
  subscriber = fresh;
}

export async function closeCacheBroadcast(): Promise<void> {
  const p = publisher;
  const s = subscriber;
  publisher = null;
  subscriber = null;
  if (p) await closeRedisClient(p);
  if (s) await closeRedisClient(s);
}
