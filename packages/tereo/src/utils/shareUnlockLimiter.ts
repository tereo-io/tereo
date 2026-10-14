import { isRedisReady, limiterUnavailable } from "./rateLimit.js";
import { getRedisClient } from "./redis.js";
import { hashFlowToken } from "./crypto.js";
import { logger } from "./logger.js";
import env from "../env.js";

// Per-IP-per-token brute-force guard for the share unlock endpoint. Keys look
// like `file-service:share-unlock:{sha256(token)}:{ip}` — the token is a
// credential, so only its hash reaches Redis — and TTL out with the window.
//
// Fails closed, like the other credential limiters (see utils/rateLimit.ts):
// without Redis, `recordUnlockAttempt` throws a 503 rather than letting
// unlimited password guesses through.

export const keyOf = (token: string, ip: string): string =>
  `file-service:share-unlock:${hashFlowToken(token)}:${ip}`;

export interface LimiterResult {
  allowed: boolean;
  /** This address's first attempt on the token in the current window. */
  first: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Record an unlock attempt and return whether it's permitted. One
 * transaction starts the window if there is none, counts the attempt and
 * reads the time left.
 */
export async function recordUnlockAttempt(
  token: string,
  ip: string
): Promise<LimiterResult> {
  const max = env.FILE_SERVICE_SHARE_UNLOCK_MAX_ATTEMPTS;
  const window = env.FILE_SERVICE_SHARE_UNLOCK_WINDOW_SECONDS;
  const key = keyOf(token, ip);

  let count: number;
  let ttl: number;
  try {
    const redis = getRedisClient();
    if (!isRedisReady(redis)) throw new Error("Redis connection is not ready");
    const exec = await redis
      .multi()
      .set(key, 0, "EX", window, "NX")
      .incr(key)
      .ttl(key)
      .exec();
    if (!exec || exec.some(([err]) => err)) {
      throw new Error("Redis transaction failed");
    }
    count = Number(exec[1]?.[1]);
    ttl = Number(exec[2]?.[1]);
    if (Number.isNaN(count) || Number.isNaN(ttl)) {
      throw new Error("Unexpected reply from Redis");
    }
  } catch (err) {
    logger.error(
      {
        tokenPrefix: token.slice(0, 4),
        err,
      },
      "Share unlock limiter unavailable; refusing"
    );
    throw limiterUnavailable();
  }

  return {
    allowed: count <= max,
    first: count === 1,
    remaining: Math.max(0, max - count),
    retryAfterSeconds: ttl > 0 ? ttl : window,
  };
}

/** Clear the counter after a successful unlock so legitimate users can retry later. */
export async function resetUnlockAttempts(
  token: string,
  ip: string
): Promise<void> {
  try {
    await getRedisClient().del(keyOf(token, ip));
  } catch (err) {
    logger.warn(
      {
        tokenPrefix: token.slice(0, 4),
        err,
      },
      "Share unlock limiter reset failed"
    );
  }
}
