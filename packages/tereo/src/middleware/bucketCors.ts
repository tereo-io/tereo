import { onBucketInvalidate } from "../utils/cacheBroadcast.js";
import { Request, Response, NextFunction } from "express";
import { BoundedCache } from "../utils/boundedCache.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";

type CorsConfig = {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposedHeaders?: string[];
  maxAgeSeconds: number;
  allowCredentials: boolean;
} | null;

// Keyed by the bucket name in the URL, which anyone can vary: bounded. Names
// with no bucket go in their own small cache with a short TTL, so a stream of
// made-up names can't push real buckets out of this one.
const cache = new BoundedCache<CorsConfig>(1000, 60_000);
const missing = new BoundedCache<true>(200, 5_000);
// Bumped by every invalidation. A lookup that started before one may have read
// the old config, so it must not cache what it read.
let generation = 0;

async function getBucketCors(name: string) {
  const existing = cache.get(name);
  if (existing !== undefined) return existing;
  if (missing.get(name)) return null;
  const startedAt = generation;
  try {
    const bucket = await db.buckets.checkByName(name);
    const value = (bucket?.corsConfig as CorsConfig) ?? null;
    if (generation === startedAt) {
      if (bucket) cache.set(name, value);
      else missing.set(name, true);
    }
    return value;
  } catch (err) {
    // This request goes without the bucket's CORS; the next one retries.
    logger.warn({ err, bucket: name }, "Bucket CORS lookup failed");
    return null;
  }
}

// The bucket schema refuses anything but header names now; a config stored
// before that may hold a value `setHeader` throws on, failing every request
// to the bucket. Such values are dropped.
const isHeaderName = (v: string) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(v);

/**
 * Apply per-bucket CORS headers to responses under /buckets/:name/objects/*.
 * Falls through to the global CORS middleware when no per-bucket config exists.
 */
export const bucketCors = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const rawName = req.params?.name;
  const bucketName = Array.isArray(rawName) ? rawName[0] : rawName;
  if (!bucketName) return next();

  const cors = await getBucketCors(bucketName);
  if (!cors) return next();

  // The global cors() has already run on actual requests and may have set
  // its own allowance; the bucket's config replaces it.
  res.removeHeader("Access-Control-Allow-Origin");
  res.removeHeader("Access-Control-Allow-Credentials");
  const origin = req.headers.origin as string | undefined;
  if (
    origin &&
    (cors.allowedOrigins.includes("*") || cors.allowedOrigins.includes(origin))
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (cors.allowCredentials) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  res.setHeader("Access-Control-Allow-Methods", cors.allowedMethods.join(", "));
  res.setHeader(
    "Access-Control-Allow-Headers",
    cors.allowedHeaders.filter(isHeaderName).join(", ")
  );
  const exposed = cors.exposedHeaders?.filter(isHeaderName) ?? [];
  if (exposed.length > 0) {
    res.setHeader("Access-Control-Expose-Headers", exposed.join(", "));
  }
  res.setHeader("Access-Control-Max-Age", String(cors.maxAgeSeconds));

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
};

/** Allow tests and management endpoints to flush the per-bucket CORS cache. */
function invalidateBucketCorsCache(name?: string) {
  generation++;
  if (name) {
    cache.delete(name);
    missing.delete(name);
  } else {
    cache.clear();
    missing.clear();
  }
}

// Any mutation anywhere in the fleet publishes on BUCKET_INVALIDATE_CHANNEL.
// Drop the local cache eagerly so stale CORS config can't outlive the change.
onBucketInvalidate((name) => {
  invalidateBucketCorsCache(name);
});
