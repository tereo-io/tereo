import { afterEach, describe, expect, it } from "vitest";
import { redisKey } from "../../utils/redis.js";
import env from "../../env.js";

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
