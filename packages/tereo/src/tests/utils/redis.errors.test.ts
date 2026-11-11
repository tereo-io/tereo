// @module-tag int
// @module-tag platform
// @module-tag redis-outage
import { startRedisProxy, withinMs } from "../support/redisOutage.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import env from "../../env.js";
import {
  broadcastBucketInvalidate,
  closeCacheBroadcast,
  startCacheSubscriber,
} from "../../utils/cacheBroadcast.js";
import {
  acquireLock,
  closeRedisConnection,
  getRedisClient,
  initializeRedis,
  redisCommand,
  releaseLock,
} from "../../utils/redis.js";

describe("closeRedisConnection", () => {
  it("does not wait for Redis to come back", async () => {
    const proxy = await startRedisProxy();

    await closeRedisConnection();
    try {
      await initializeRedis({ ...env, REDIS_URL: proxy.url });
      await startCacheSubscriber();
      await broadcastBucketInvalidate("redis-shutdown-test");
      const client = getRedisClient();

      proxy.cut();
      while (client.status === "ready") {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Commands still waiting for Redis when shutdown begins: QUIT queues
      // behind them.
      void client.get("redis-shutdown-test").catch(() => undefined);
      void broadcastBucketInvalidate("redis-shutdown-test");

      await withinMs(closeCacheBroadcast(), 3_000, "closeCacheBroadcast");
      await withinMs(closeRedisConnection(), 3_000, "closeRedisConnection");

      const attempts = proxy.state.attempts;
      await new Promise((r) => setTimeout(r, 1_500));
      expect(proxy.state.attempts).toBe(attempts);
    } finally {
      await withinMs(closeRedisConnection(), 3_000, "cleanup").catch(
        () => undefined
      );
      await proxy.close();
      await initializeRedis(env);
    }
  }, 15_000);
});

describe("commands for a request during a Redis outage", () => {
  const unavailable = { statusCode: 503, code: "temporarily_unavailable" };

  it("fail at once instead of waiting for Redis to come back", async () => {
    const proxy = await startRedisProxy();

    await closeRedisConnection();
    try {
      await initializeRedis({ ...env, REDIS_URL: proxy.url });
      const token = await acquireLock("redis-outage-held");
      const client = getRedisClient();

      proxy.cut();
      while (client.status === "ready") {
        await new Promise((r) => setTimeout(r, 10));
      }

      await expect(
        withinMs(acquireLock("redis-outage-test"), 1_000, "acquireLock")
      ).rejects.toMatchObject(unavailable);
      await expect(
        withinMs(
          redisCommand((redis) => redis.get("redis-outage-test")),
          1_000,
          "redisCommand"
        )
      ).rejects.toMatchObject(unavailable);
      // The lock is left to its TTL: failing here would discard the work
      // done under it.
      expect(
        await withinMs(
          releaseLock("redis-outage-held", token as string),
          1_000,
          "releaseLock"
        )
      ).toBe(false);
    } finally {
      await withinMs(closeRedisConnection(), 3_000, "cleanup").catch(
        () => undefined
      );
      await proxy.close();
      await initializeRedis(env);
    }
  }, 15_000);

  describe("on a connection that stopped answering", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("give up after the deadline", async () => {
      vi.spyOn(getRedisClient(), "set").mockReturnValue(
        new Promise<never>(() => undefined)
      );
      vi.useFakeTimers();
      const pending = acquireLock("redis-silent-test");
      const outcome = expect(pending).rejects.toMatchObject(unavailable);
      await vi.advanceTimersByTimeAsync(2_000);
      await outcome;
    });
  });
});
