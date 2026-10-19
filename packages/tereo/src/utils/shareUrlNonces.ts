import { isRedisReady, limiterUnavailable } from "./rateLimit.js";
import { getRedisClient, redisKey } from "./redis.js";
import { ForbiddenError } from "./errors.js";
import { logger } from "./logger.js";
import env from "../env.js";

// Single-use signed URLs for shares with `maxDownloads`. The URL's nonce,
// already bound by its HMAC, is stored when the URL is minted and deleted by
// the first request that uses it, so a capped share's URL serves once. Keys
// look like `file-service:share-url:{shareId}:{nonce}` and expire with the URL.
//
// Fails closed: without Redis a capped share neither mints nor serves (503).

const keyOf = (shareId: string, nonce: string): string =>
  redisKey(`file-service:share-url:${shareId}:${nonce}`);

const readyRedis = () => {
  const redis = getRedisClient();
  if (!isRedisReady(redis)) throw new Error("Redis connection is not ready");
  return redis;
};

/** Records a freshly minted URL's nonce, live until the URL expires. */
export async function storeShareUrlNonce(
  shareId: string,
  nonce: string,
  expiresAt: Date
): Promise<void> {
  const ttl =
    Math.ceil((expiresAt.getTime() - Date.now()) / 1000) +
    env.FILE_SERVICE_PRESIGN_CLOCK_SKEW_SECONDS;
  try {
    await readyRedis().set(keyOf(shareId, nonce), "1", "EX", Math.max(1, ttl));
  } catch (err) {
    logger.error(
      { shareId, err },
      "Share URL nonce store unavailable; refusing"
    );
    throw limiterUnavailable();
  }
}

/**
 * Spends a URL's nonce. A nonce that was never stored, already spent or
 * expired is the same 403 as a bad signature.
 */
export async function consumeShareUrlNonce(
  shareId: string,
  nonce: string
): Promise<void> {
  let stored: string | null;
  try {
    stored = await readyRedis().getdel(keyOf(shareId, nonce));
  } catch (err) {
    logger.error(
      { shareId, err },
      "Share URL nonce store unavailable; refusing"
    );
    throw limiterUnavailable();
  }
  if (stored === null) {
    throw new ForbiddenError("Signed URL already used");
  }
}
