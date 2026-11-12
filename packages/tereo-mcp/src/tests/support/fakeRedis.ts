import type { RateLimitRedis } from "../../types.js";

export interface FakeRedis extends RateLimitRedis {
  counts: Map<string, number>;
  expiries: Map<string, number>;
  failIncr: Error | null;
}

export const fakeRedis = (ttlSeconds = 42): FakeRedis => {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  const redis = {
    counts,
    expiries,
    failIncr: null as Error | null,
    incr: async (key: string) => {
      if (redis.failIncr) throw redis.failIncr;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    expire: async (key: string, seconds: number) => {
      expiries.set(key, seconds);
      return 1;
    },
    ttl: async () => ttlSeconds,
  };
  return redis as unknown as FakeRedis;
};
