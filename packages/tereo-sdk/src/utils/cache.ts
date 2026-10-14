import type { Redis } from "ioredis";
import { logger } from "./logger.js";

let client: Redis | null = null;
let namespace = "";

/**
 * The connection the caches use: the one passed to `createCoreClient`.
 * `scope` (from the service's client id) prefixes every key. Core answers
 * each service by its own credentials — introspection by audience, reads by
 * its grants — so one service must never be served what another cached.
 */
export const useCacheRedis = (redis: Redis | null, scope?: string): void => {
  client = redis;
  namespace = scope ? `${scope}:` : "";
};

const scoped = (key: string) => `${namespace}${key}`;

export const getCacheRedis = (): Redis => {
  if (!client) throw new Error("@tereo-io/sdk: cache used before start()");
  return client;
};

export const buildCachePrefix = (sdk: string, version = 1): string =>
  `${sdk}:v${version}:`;

// Caches are an optimisation: a Redis failure falls through to core.
export const safeCacheGet = async <T>(key: string): Promise<T | undefined> => {
  try {
    const raw = await getCacheRedis().get(scoped(key));
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch (err) {
    logger.warn({ key, err }, "Cache read failed; falling through");
    return undefined;
  }
};

export const safeCacheSet = async (
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> => {
  try {
    await getCacheRedis().set(
      scoped(key),
      JSON.stringify(value),
      "EX",
      ttlSeconds
    );
  } catch (err) {
    logger.warn({ key, err }, "Cache write failed; ignoring");
  }
};

export const safeCacheDel = async (...keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  try {
    await getCacheRedis().del(...keys.map(scoped));
  } catch (err) {
    logger.warn({ keys, err }, "Cache delete failed; ignoring");
  }
};

export class ScopedCache {
  constructor(public readonly prefix: string) {}

  key(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  get<T>(suffix: string): Promise<T | undefined> {
    return safeCacheGet<T>(this.key(suffix));
  }

  set(suffix: string, value: unknown, ttlSeconds: number): Promise<void> {
    return safeCacheSet(this.key(suffix), value, ttlSeconds);
  }

  del(...suffixes: string[]): Promise<void> {
    return safeCacheDel(...suffixes.map((s) => this.key(s)));
  }
}
