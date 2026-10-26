// @module-tag int
// @module-tag platform
import { afterEach, describe, expect, it } from "vitest";
import env from "../../env.js";
import {
  acquireLock,
  closeRedisConnection,
  getRedisClient,
  initializeRedis,
  redisKey,
  releaseLock,
} from "../../utils/redis.js";

describe("acquireLock", () => {
  it("takes the lock prefix from the env Redis was initialized with", async () => {
    await closeRedisConnection();
    try {
      await initializeRedis({ ...env, REDIS_KEY_PREFIX: "itest-lock:" });
      const token = await acquireLock("redis-key-prefix-test");
      expect(token).not.toBeNull();
      const key = `itest-lock:${env.SERVICE_NAME}:lock:redis-key-prefix-test`;
      expect(await getRedisClient().get(key)).toBe(token);
      expect(await releaseLock("redis-key-prefix-test", token as string)).toBe(
        true
      );
    } finally {
      await closeRedisConnection();
      await initializeRedis(env);
    }
  });
});

describe("redisKey", () => {
  const original = env.REDIS_KEY_PREFIX;
  afterEach(() => {
    env.REDIS_KEY_PREFIX = original;
  });

  it("leaves keys unchanged without a prefix", () => {
    env.REDIS_KEY_PREFIX = "";
    expect(redisKey("tereo:lock:abc")).toBe("tereo:lock:abc");
    expect(redisKey("bull")).toBe("bull");
  });

  it("joins parts with a colon", () => {
    env.REDIS_KEY_PREFIX = "";
    expect(redisKey("tereo", "lock:")).toBe("tereo:lock:");
  });

  it("prepends the prefix verbatim", () => {
    env.REDIS_KEY_PREFIX = "app1:";
    expect(redisKey("rl:auth:fail")).toBe("app1:rl:auth:fail");
    expect(redisKey("socket.io")).toBe("app1:socket.io");
  });
});
