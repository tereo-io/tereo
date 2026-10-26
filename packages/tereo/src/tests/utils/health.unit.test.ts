// @module-tag unit
// @module-tag platform
import { afterEach, describe, expect, it, vi } from "vitest";

const healthCheck = vi.fn(async () => true);

const ping = vi.fn(async () => "PONG");

const loadHealth = async () => {
  vi.resetModules();
  vi.doMock("../../utils/db/prisma.js", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    healthCheck,
  }));
  vi.doMock("../../utils/redis.js", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getRedisClient: () => ({ ping }),
  }));
  return import("../../utils/health.js");
};

describe("probeDependenciesCached", () => {
  afterEach(() => {
    vi.doUnmock("../../utils/db/prisma.js");
    vi.doUnmock("../../utils/redis.js");
    vi.restoreAllMocks();
    healthCheck.mockClear();
    ping.mockClear();
  });

  it("probes once a second however often it is asked", async () => {
    const { probeDependenciesCached } = await loadHealth();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => probeDependenciesCached())
    );
    expect(results).toEqual(
      Array.from({ length: 5 }, () => ({ dbOk: true, redisOk: true }))
    );
    now.mockReturnValue(start + 999);
    await probeDependenciesCached();
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 1_000);
    await probeDependenciesCached();
    expect(healthCheck).toHaveBeenCalledTimes(2);
  });
});

describe("readiness", () => {
  afterEach(() => {
    vi.doUnmock("../../utils/db/prisma.js");
    vi.doUnmock("../../utils/redis.js");
    healthCheck.mockClear();
  });

  it.each([
    [false, "ok"],
    [true, "draining"],
  ])("with draining %s reports %s", async (draining, status) => {
    const { readiness, setDraining } = await import("../../utils/health.js");
    setDraining(draining);

    expect(readiness().status).toBe(status);
  });

  it("ignores a failing dependency", async () => {
    healthCheck.mockRejectedValueOnce(new Error("pool exhausted"));
    const { probeDependencies, readiness, setDraining } = await loadHealth();
    setDraining(false);

    await probeDependencies();

    expect(readiness().status).toBe("ok");
  });
});
