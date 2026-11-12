import { createRateLimiter } from "../rateLimit.js";
import { fakeRedis } from "./support/fakeRedis.js";
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import pino from "pino";

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "debug" },
    { write: (s: string) => lines.push(JSON.parse(s)) }
  ) as Logger;
  return { logger, lines };
};

describe("createRateLimiter", () => {
  it("allows the 120th call in a window and refuses the 121st with the ttl", async () => {
    const redis = fakeRedis(37);
    const limit = createRateLimiter({
      redis,
      service: "svc",
      perMinute: 120,
      logger: capture().logger,
    });
    for (let i = 0; i < 120; i++) {
      expect(await limit("u1")).toEqual({ allowed: true });
    }
    expect(await limit("u1")).toEqual({
      allowed: false,
      retryAfterSeconds: 37,
    });
  });

  it("sets a 60 second expiry on the first call only", async () => {
    const redis = fakeRedis();
    const limit = createRateLimiter({
      redis,
      service: "svc",
      perMinute: 5,
      logger: capture().logger,
    });
    await limit("u1");
    expect(redis.expiries.get("@tereo-io/mcp:svc:rl:u1")).toBe(60);
    redis.expiries.clear();
    await limit("u1");
    expect(redis.expiries.size).toBe(0);
  });

  it("keeps a separate count per user", async () => {
    const limit = createRateLimiter({
      redis: fakeRedis(),
      service: "svc",
      perMinute: 1,
      logger: capture().logger,
    });
    expect((await limit("a")).allowed).toBe(true);
    expect((await limit("b")).allowed).toBe(true);
    expect((await limit("a")).allowed).toBe(false);
  });

  it("allows the call and logs at error when redis fails", async () => {
    const redis = fakeRedis();
    redis.failIncr = new Error("ECONNREFUSED");
    const { logger, lines } = capture();
    const limit = createRateLimiter({
      redis,
      service: "svc",
      perMinute: 1,
      logger,
    });
    expect(await limit("u1")).toEqual({ allowed: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 50 });
    expect((lines[0].err as { message: string }).message).toBe("ECONNREFUSED");
  });

  it("allows the first call when expire fails, and re-arms the expiry on a later call", async () => {
    const redis = fakeRedis();
    redis.failExpire = new Error("EXPIRE lost");
    const limit = createRateLimiter({
      redis,
      service: "svc",
      perMinute: 5,
      logger: capture().logger,
    });
    expect(await limit("u1")).toEqual({ allowed: true });
    expect(redis.expiries.size).toBe(0);

    redis.failExpire = null;
    redis.ttlSeconds = -1;
    expect(await limit("u1")).toEqual({ allowed: true });
    expect(redis.expiries.get("@tereo-io/mcp:svc:rl:u1")).toBe(60);
  });

  it("sets an expiry on a key left without one over the limit, and reports 60", async () => {
    const redis = fakeRedis(-1);
    redis.counts.set("@tereo-io/mcp:svc:rl:u1", 9);
    const limit = createRateLimiter({
      redis,
      service: "svc",
      perMinute: 1,
      logger: capture().logger,
    });
    expect(await limit("u1")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(redis.expiries.get("@tereo-io/mcp:svc:rl:u1")).toBe(60);
  });

  it.each(["failExpire", "failTtl"] as const)(
    "allows an over-limit call and logs at error when %s",
    async (failure) => {
      const redis = fakeRedis(-1);
      redis.counts.set("@tereo-io/mcp:svc:rl:u1", 9);
      redis[failure] = new Error("redis down");
      const { logger, lines } = capture();
      const limit = createRateLimiter({
        redis,
        service: "svc",
        perMinute: 1,
        logger,
      });
      expect(await limit("u1")).toEqual({ allowed: true });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 50 });
      expect((lines[0].err as { message: string }).message).toBe("redis down");
    }
  );
});
