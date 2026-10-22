import { getRedisClient, redisKey } from "../../utils/redis.js";

/**
 * Redis keys one test can leave behind for the next: rate-limit buckets and
 * idempotency claims. `setup/setup.ts` clears them before every test.
 */
export const TEST_STATE_KEY_PATTERNS = [
  "rl:*",
  "tereo:ratelimit*",
  "webhook-service:idempotency:*",
  "audit-log-service:idempotency:*",
];

/**
 * Clears the keys in TEST_STATE_KEY_PATTERNS, so a test that sends more
 * requests than a limiter allows can start it over between bursts.
 */
export async function resetRateLimits(): Promise<void> {
  const redis = getRedisClient();
  for (const pattern of TEST_STATE_KEY_PATTERNS) {
    const keys = await redis.keys(redisKey(pattern));
    if (keys.length > 0) await redis.del(keys);
  }
}
