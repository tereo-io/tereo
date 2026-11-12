import type { RateLimitRedis } from "../../types.js";

export interface FakeRedis extends RateLimitRedis {
  counts: Map<string, number>;
  expiries: Map<string, number>;
  failIncr: Error | null;
  failExpire: Error | null;
  failTtl: Error | null;
  // What ttl() answers; -1 is Redis's answer for a key with no expiry.
  ttlSeconds: number;
}

export const fakeRedis = (ttlSeconds = 42): FakeRedis => {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  const redis = {
    counts,
    expiries,
    failIncr: null as Error | null,
    failExpire: null as Error | null,
    failTtl: null as Error | null,
    ttlSeconds,
    incr: async (key: string) => {
      if (redis.failIncr) throw redis.failIncr;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    expire: async (key: string, seconds: number) => {
      if (redis.failExpire) throw redis.failExpire;
      expiries.set(key, seconds);
      return 1;
    },
    ttl: async () => {
      if (redis.failTtl) throw redis.failTtl;
      return redis.ttlSeconds;
    },
  };
  return redis as unknown as FakeRedis;
};
