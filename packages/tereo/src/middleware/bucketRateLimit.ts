import { onBucketInvalidate } from "../utils/cacheBroadcast.js";
import { getRedisClient, redisKey } from "../utils/redis.js";
import { Request, Response, NextFunction } from "express";
import { TooManyRequestsError } from "../utils/errors.js";
import { BoundedCache } from "../utils/boundedCache.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";

interface CachedConfig {
  value: {
    tokensPerSecond: number;
    maxTokens: number;
    requestCost: number;
  } | null;
  bucketId: number | null;
}

// Keyed by the bucket name in the URL, which anyone can vary: bounded.
const cache = new BoundedCache<CachedConfig>(1000, 60_000);
// Bumped by every invalidation. A lookup that started before one may have read
// the old config, so it must not cache what it read.
let generation = 0;

// Lua token bucket: returns 1 if acquired else 0, plus the remaining tokens.
// KEYS[1]: bucket key  ARGV: now(ms), cost, maxTokens, tokensPerSec, ttlSec
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local rate = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local data = redis.call('HMGET', key, 'tokens', 'last')
local tokens = tonumber(data[1])
local last = tonumber(data[2])
if tokens == nil or last == nil then
  tokens = max
  last = now
end
local elapsed = math.max(0, now - last) / 1000.0
tokens = math.min(max, tokens + elapsed * rate)
local acquired = 0
if tokens >= cost then
  tokens = tokens - cost
  acquired = 1
end
redis.call('HMSET', key, 'tokens', tokens, 'last', now)
redis.call('EXPIRE', key, ttl)
return { acquired, tostring(tokens) }
`;

async function getConfig(name: string): Promise<CachedConfig> {
  const hit = cache.get(name);
  if (hit) return hit;
  const startedAt = generation;
  try {
    const bucket = await db.buckets.checkByName(name);
    const raw = bucket?.rateLimitConfig as CachedConfig["value"];
    const fresh: CachedConfig = {
      value: raw ?? null,
      bucketId: bucket?.id ?? null,
    };
    if (generation === startedAt) cache.set(name, fresh);
    return fresh;
  } catch (err) {
    // This request fails open; the next one retries the lookup.
    logger.warn(
      { err, bucket: name },
      "Per-bucket rate-limit config lookup failed; failing open"
    );
    return { value: null, bucketId: null };
  }
}

export const bucketRateLimit = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Authenticated routes mount this middleware under `/buckets/:name`; signed
  // routes (no auth) use `/signed/objects/:bucket/...`. Accept either so
  // presigned traffic still counts against per-bucket limits rather than
  // silently bypassing them.
  const rawName = req.params?.name ?? req.params?.bucket;
  const bucketName = Array.isArray(rawName) ? rawName[0] : rawName;
  if (!bucketName) return next();

  const { value, bucketId } = await getConfig(bucketName);
  if (!value || !bucketId) return next();

  const userId =
    (req as Request & { auth?: { userId?: string } }).auth?.userId ?? "anon";
  const key = redisKey(`file-service:bucket:${bucketId}:user:${userId}`);

  const redis = getRedisClient();
  try {
    // The shared Redis client (utils/redis.ts) sets no commandTimeout,
    // so race the eval against a local 500ms deadline. If Redis hangs we fall
    // open per the existing catch behavior — the global limiter still applies.
    const EVAL_TIMEOUT_MS = 500;
    const evalPromise = redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      Date.now(),
      value.requestCost,
      value.maxTokens,
      value.tokensPerSecond,
      3600
    ) as Promise<[number, string]>;

    let timeoutHandle: NodeJS.Timeout | undefined;
    const result = await Promise.race<[number, string] | "timeout">([
      evalPromise.then((r) => r as [number, string]),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), EVAL_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });
    if (result === "timeout") {
      // Fail-open on Redis slowness.
      logger.warn(
        { bucket: bucketName, timeoutMs: EVAL_TIMEOUT_MS },
        "Per-bucket rate-limit check skipped due to Redis timeout; failing open"
      );
      return next();
    }
    if (result[0] !== 1) {
      // The X-RateLimit-* headers are set only here, so an allowed request
      // keeps the general limiter's.
      const tokens = Number(result[1]) || 0;
      const msBeforeNext = Math.ceil(
        (Math.max(0, value.requestCost - tokens) /
          Math.max(value.tokensPerSecond, 0.1)) *
          1000
      );
      const retryAfter = Math.max(1, Math.ceil(msBeforeNext / 1000));
      res.setHeader("X-RateLimit-Limit", value.maxTokens);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, Math.floor(tokens)));
      res.setHeader(
        "X-RateLimit-Reset",
        new Date(Date.now() + msBeforeNext).toISOString()
      );
      return next(
        new TooManyRequestsError(retryAfter, "Per-bucket rate limit exceeded")
      );
    }
  } catch (err) {
    // Fail-open on Redis errors — the global limiter still provides protection.
    // Log so operators can see when per-bucket limits aren't actually enforcing.
    logger.warn(
      {
        bucket: bucketName,
        err,
      },
      "Per-bucket rate-limit check skipped due to Redis error; failing open"
    );
  }
  next();
};

function invalidateBucketRateLimitCache(name?: string) {
  generation++;
  if (name) cache.delete(name);
  else cache.clear();
}

onBucketInvalidate((name) => {
  invalidateBucketRateLimitCache(name);
});
