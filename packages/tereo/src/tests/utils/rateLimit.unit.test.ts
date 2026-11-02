// @module-tag unit
// @module-tag platform
import { afterEach, describe, it, expect, vi } from "vitest";
import { ipRateLimitKey } from "../../utils/rateLimit.js";

describe("ipRateLimitKey", () => {
  it("counts every address of an IPv6 /64 as one", () => {
    expect(ipRateLimitKey("2001:db8:1:2:aaaa::1")).toBe(
      ipRateLimitKey("2001:db8:1:2:bbbb::2")
    );
    expect(ipRateLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipRateLimitKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe(
      "2001:db8:1:2::/64"
    );
    expect(ipRateLimitKey("::1")).toBe("0:0:0:0::/64");
  });

  it("keeps different /64s apart", () => {
    expect(ipRateLimitKey("2001:db8:1:2::1")).not.toBe(
      ipRateLimitKey("2001:db8:1:3::1")
    );
  });

  it("unwraps IPv4-mapped IPv6", () => {
    expect(ipRateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipRateLimitKey("::FFFF:102:304")).toBe("1.2.3.4");
  });

  it("leaves IPv4 and non-addresses unchanged", () => {
    expect(ipRateLimitKey("1.2.3.4")).toBe("1.2.3.4");
    expect(ipRateLimitKey("unknown")).toBe("unknown");
  });
});

describe("general limiter default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("rate-limiter-flexible");
    vi.doUnmock("../../utils/redis.js");
    vi.resetModules();
  });

  it("takes its limit from RATE_LIMIT_PER_SECOND", async () => {
    vi.stubEnv("RATE_LIMIT_PER_SECOND", "7");
    vi.resetModules();
    vi.doMock("../../utils/redis.js", () => ({
      getRedisClient: () => ({}),
      redisKey: (key: string) => key,
    }));
    vi.doMock("rate-limiter-flexible", async (importOriginal) => ({
      ...(await importOriginal<typeof import("rate-limiter-flexible")>()),
      RateLimiterRedis: class {
        consume = async () => ({
          consumedPoints: 1,
          remainingPoints: 6,
          msBeforeNext: 1000,
          isFirstInDuration: true,
        });
      },
    }));
    const { createRateLimitMiddleware } =
      await import("../../utils/rateLimit.js");
    const headers: Record<string, unknown> = {};
    const res = { setHeader: (k: string, v: unknown) => (headers[k] = v) };
    const req = { socket: { remoteAddress: "203.0.113.9" }, headers: {} };
    await new Promise<void>((resolve) =>
      createRateLimitMiddleware("t")(req as never, res as never, () =>
        resolve()
      )
    );
    expect(headers["X-RateLimit-Limit"]).toBe(7);
  });
});

describe("per-user override in the limiters", () => {
  const constructed: { points: number; keyPrefix: string }[] = [];
  const consumed: { points: number; key: string }[] = [];

  const load = async () => {
    constructed.length = 0;
    consumed.length = 0;
    vi.resetModules();
    vi.doMock("../../utils/redis.js", () => ({
      getRedisClient: () => ({}),
      redisKey: (key: string) => key,
    }));
    vi.doMock("rate-limiter-flexible", async (importOriginal) => ({
      ...(await importOriginal<typeof import("rate-limiter-flexible")>()),
      RateLimiterRedis: class {
        points: number;
        constructor(opts: { points: number; keyPrefix: string }) {
          this.points = opts.points;
          constructed.push({ points: opts.points, keyPrefix: opts.keyPrefix });
        }
        consume = async (key: string) => {
          consumed.push({ points: this.points, key });
          return {
            consumedPoints: 1,
            remainingPoints: this.points - 1,
            msBeforeNext: 1000,
            isFirstInDuration: true,
          };
        };
      },
    }));
    return import("../../utils/rateLimit.js");
  };

  const run = async (
    middleware: (req: never, res: never, next: () => void) => Promise<void>,
    req: object
  ) => {
    const headers: Record<string, unknown> = {};
    const res = { setHeader: (k: string, v: unknown) => (headers[k] = v) };
    await new Promise<void>((resolve) =>
      middleware(
        {
          socket: { remoteAddress: "203.0.113.9" },
          headers: {},
          ...req,
        } as never,
        res as never,
        () => resolve()
      )
    );
    return headers;
  };

  afterEach(() => {
    vi.doUnmock("rate-limiter-flexible");
    vi.doUnmock("../../utils/redis.js");
    vi.resetModules();
  });

  const user = (rateLimitPerSecond: number | null, userType = "human") => ({
    auth: { userId: "u1", userType, oauthClientId: null, rateLimitPerSecond },
  });

  it("applies the override of an authenticated user", async () => {
    const { createRateLimitMiddleware } = await load();
    const headers = await run(createRateLimitMiddleware("t") as never, user(3));
    expect(headers["X-RateLimit-Limit"]).toBe(3);
    expect(consumed).toEqual([{ points: 3, key: "user:u1" }]);
  });

  it("uses the tier default when the override is null", async () => {
    const { createRateLimitMiddleware } = await load();
    const headers = await run(
      createRateLimitMiddleware("t") as never,
      user(null)
    );
    expect(headers["X-RateLimit-Limit"]).toBe(100);
  });

  it("replaces the internal default for an internal service account", async () => {
    const { createRateLimitMiddleware } = await load();
    const headers = await run(createRateLimitMiddleware("t") as never, {
      socket: { remoteAddress: "10.0.0.5" },
      auth: {
        userId: "s1",
        userType: "service_account",
        oauthClientId: "c1",
        rateLimitPerSecond: 50,
      },
    });
    expect(headers["X-RateLimit-Limit"]).toBe(50);
    expect(consumed).toEqual([{ points: 50, key: "svc:c1" }]);
  });

  it("never applies an override without req.auth; the IP gets the default", async () => {
    const { createRateLimitMiddleware } = await load();
    const headers = await run(createRateLimitMiddleware("t") as never, {});
    expect(headers["X-RateLimit-Limit"]).toBe(100);
    expect(consumed).toEqual([{ points: 100, key: "ip:203.0.113.9" }]);
  });

  it("never applies an override in the pre-auth limiter", async () => {
    const { createPreAuthRateLimitMiddleware } = await load();
    await run(createPreAuthRateLimitMiddleware("t") as never, user(3));
    expect(consumed).toEqual([{ points: 300, key: "ip:203.0.113.9" }]);
    expect(constructed.every((c) => c.points !== 3)).toBe(true);
  });

  it("reuses one limiter for the same points value", async () => {
    const { createRateLimitMiddleware } = await load();
    const middleware = createRateLimitMiddleware("t") as never;
    const before = constructed.length;
    await run(middleware, user(3));
    await run(middleware, user(3));
    await run(middleware, user(3));
    expect(constructed.length - before).toBe(1);
    await run(middleware, user(4));
    expect(constructed.length - before).toBe(2);
  });

  it("shares one Redis key prefix across override values", async () => {
    const { createRateLimitMiddleware } = await load();
    const middleware = createRateLimitMiddleware("t") as never;
    await run(middleware, user(3));
    await run(middleware, user(4));
    const overrides = constructed.filter(
      (c) => c.points === 3 || c.points === 4
    );
    expect(new Set(overrides.map((c) => c.keyPrefix))).toEqual(
      new Set(["t:ratelimit"])
    );
  });
});
