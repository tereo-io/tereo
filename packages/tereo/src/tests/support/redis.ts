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

/** The per-IP request limiters of `utils/rateLimit.ts`, by key prefix. */
const REQUEST_LIMITER_PREFIXES = {
  general: "tereo:ratelimit",
  preauth: "tereo:ratelimit:preauth",
  preflight: "tereo:ratelimit:preflight",
  health: "tereo:ratelimit:health",
} as const;

/**
 * Spends all but `remaining` of `limit` in an address's external-tier window
 * of a request limiter, and holds that window open for a minute instead of a
 * second. A test then reaches the limit in a few requests rather than a
 * flood the runner would have to deliver inside one second. The key and the
 * integer count are rate-limiter-flexible's: `<prefix>:<key>`.
 */
export async function spendRateLimit(
  limiter: keyof typeof REQUEST_LIMITER_PREFIXES,
  ip: string,
  limit: number,
  remaining: number
): Promise<void> {
  const key = redisKey(`${REQUEST_LIMITER_PREFIXES[limiter]}:ip:${ip}`);
  await getRedisClient().set(key, limit - remaining, "PX", 60_000);
}

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
