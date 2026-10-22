import { closeWorkerQueues, startWorker, stopWorker } from "../worker.js";
import { startRedisProxy, withinMs } from "./support/redisOutage.js";
import { describe, expect, it } from "vitest";
import env from "../env.js";
import {
  closeRedisConnection,
  getRedisClient,
  initializeRedis,
} from "../utils/redis.js";

describe("stopping the worker while Redis is unreachable", () => {
  it("does not wait for Redis to come back", async () => {
    const proxy = await startRedisProxy();

    await closeRedisConnection();
    try {
      await initializeRedis({ ...env, REDIS_URL: proxy.url });
      await startWorker();
      const client = getRedisClient();

      proxy.cut();
      while (client.status === "ready") {
        await new Promise((r) => setTimeout(r, 10));
      }

      await withinMs(stopWorker(), 10_000, "stopWorker");
      await withinMs(closeWorkerQueues(), 10_000, "closeWorkerQueues");
      await closeRedisConnection();

      // Nothing the worker opened is still reconnecting.
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
  }, 30_000);
});
