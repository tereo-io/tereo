import { createLimiters, createRateLimiter } from "../rateLimit.js";
import type { TereoMcpOptions, ToolDefinition } from "../types.js";
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

describe("createLimiters", () => {
  const tool = (
    name: string,
    rateLimit?: ToolDefinition["rateLimit"]
  ): ToolDefinition => ({
    name,
    description: "d",
    permission: null,
    readOnly: true,
    handler: () => "ok",
    ...(rateLimit !== undefined && { rateLimit }),
  });
  const limitersFor = (
    options: Pick<TereoMcpOptions, "name" | "redis" | "rateLimit">,
    ...tools: ToolDefinition[]
  ) => createLimiters(options, tools, capture().logger);

  it("counts a tool with its own limit under its own key, apart from the server-wide count", async () => {
    const redis = fakeRedis();
    const limiters = limitersFor(
      { name: "svc", redis, rateLimit: { perMinute: 2 } },
      tool("own", { perMinute: 1 }),
      tool("shared")
    );
    const own = limiters.get("own");
    const shared = limiters.get("shared");

    expect((await own?.("u1"))?.allowed).toBe(true);
    expect((await own?.("u1"))?.allowed).toBe(false);
    expect((await shared?.("u1"))?.allowed).toBe(true);
    expect((await shared?.("u1"))?.allowed).toBe(true);
    expect((await shared?.("u1"))?.allowed).toBe(false);
    expect((await own?.("u1"))?.allowed).toBe(false);
    expect([...redis.counts.keys()].sort()).toEqual([
      "@tereo-io/mcp:svc:rl:u1",
      "@tereo-io/mcp:svc:rl:u1:own",
    ]);
    expect(redis.counts.get("@tereo-io/mcp:svc:rl:u1")).toBe(3);
    expect(redis.counts.get("@tereo-io/mcp:svc:rl:u1:own")).toBe(3);
  });

  it("leaves an exempt tool unlimited", () => {
    const limiters = limitersFor(
      { name: "svc", redis: fakeRedis(), rateLimit: { perMinute: 1 } },
      tool("free", false),
      tool("shared")
    );

    expect(limiters.has("free")).toBe(false);
    expect(limiters.has("shared")).toBe(true);
  });

  it("limits a tool with its own limit when the server-wide limit is off", () => {
    const limiters = limitersFor(
      { name: "svc", redis: fakeRedis(), rateLimit: false },
      tool("own", { perMinute: 5 }),
      tool("shared")
    );

    expect(limiters.has("own")).toBe(true);
    expect(limiters.has("shared")).toBe(false);
  });

  it("shares one server-wide counter across tools", async () => {
    const redis = fakeRedis();
    const limiters = limitersFor(
      { name: "svc", redis, rateLimit: { perMinute: 1 } },
      tool("a"),
      tool("b")
    );

    expect((await limiters.get("a")?.("u1"))?.allowed).toBe(true);
    expect((await limiters.get("b")?.("u1"))?.allowed).toBe(false);
  });

  it("allows a call and logs at error when redis fails under a tool's own limit", async () => {
    const redis = fakeRedis();
    redis.failIncr = new Error("ECONNREFUSED");
    const { logger, lines } = capture();
    const limiters = createLimiters(
      { name: "svc", redis, rateLimit: false },
      [tool("own", { perMinute: 1 })],
      logger
    );

    expect(await limiters.get("own")?.("u1")).toEqual({ allowed: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 50 });
  });
});
