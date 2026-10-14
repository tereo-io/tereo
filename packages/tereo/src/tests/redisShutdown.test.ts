import { startRedisProxy, withinMs } from "./utils/redisOutage.js";
import { describe, expect, it } from "vitest";
import env from "../env.js";
import {
  broadcastBucketInvalidate,
  closeCacheBroadcast,
  startCacheSubscriber,
} from "../utils/cacheBroadcast.js";
import {
  closeRedisConnection,
  getRedisClient,
  initializeRedis,
} from "../utils/redis.js";

describe("closing Redis connections while Redis is unreachable", () => {
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
