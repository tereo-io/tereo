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
