// @module-tag int
// @module-tag platform
import { getRedisClient, redisKey } from "../../utils/redis.js";
import { TrackedWorker } from "../../jobs/workerRegistry.js";
import { afterEach, describe, expect, it } from "vitest";
import { createQueue } from "../../utils/bullmq.js";
import env from "../../env.js";

const QUEUE = "redis-key-prefix-test";

describe("createQueue", () => {
  const original = env.REDIS_KEY_PREFIX;
  afterEach(async () => {
    env.REDIS_KEY_PREFIX = original;
    const redis = getRedisClient();
    const keys = await redis.keys(`*${QUEUE}*`);
    if (keys.length > 0) await redis.del(keys);
  });

  it("puts queue and worker under the prefix, where they still meet", async () => {
    env.REDIS_KEY_PREFIX = "itest-prefix:";
    const queue = createQueue<{ n: number }>(QUEUE);
    let done!: (n: number) => void;
    const processed = new Promise<number>((resolve) => (done = resolve));
    const worker = new TrackedWorker<{ n: number }>(
      QUEUE,
      async (job) => done(job.data.n),
      { connection: getRedisClient().duplicate() }
    );
    try {
      await queue.add("job", { n: 42 });
      expect(await processed).toBe(42);
      const redis = getRedisClient();
      expect(
        (await redis.keys(`itest-prefix:bull:${QUEUE}:*`)).length
      ).toBeGreaterThan(0);
      expect(await redis.keys(`bull:${QUEUE}:*`)).toEqual([]);
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it("keeps BullMQ's default prefix when none is set", () => {
    env.REDIS_KEY_PREFIX = "";
    expect(redisKey("bull")).toBe("bull");
  });
});
