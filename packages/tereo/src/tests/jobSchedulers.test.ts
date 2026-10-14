import { getIdempotencySweepQueue } from "../jobs/queues.js";
import { getRedisClient } from "../utils/redis.js";
import { describe, it, expect } from "vitest";
import {
  startIdempotencySweep,
  stopIdempotencySweep,
} from "../jobs/idempotencySweep.js";

const HOUR_MS = 60 * 60 * 1000;
const SCHEDULER = "idempotency-sweep-scheduler";

describe("job schedulers", () => {
  it("installs a job's current schedule on every start", async () => {
    const redis = getRedisClient();
    const queue = getIdempotencySweepQueue();
    // An earlier start, moments ago, with a different interval; the lease
    // that once gated the upsert is still held.
    await redis.set(
      `file-service:scheduler-leader:${SCHEDULER}`,
      "1",
      "EX",
      600
    );
    // Paused, so no worker starts a sweep this test then closes under it.
    await queue.pause();
    await queue.upsertJobScheduler(
      SCHEDULER,
      { every: 2 * HOUR_MS },
      { name: "idempotency-sweep" }
    );

    try {
      await startIdempotencySweep();
      expect((await queue.getJobScheduler(SCHEDULER))?.every).toBe(HOUR_MS);
    } finally {
      await stopIdempotencySweep();
      await redis.del(`file-service:scheduler-leader:${SCHEDULER}`);
      await queue.upsertJobScheduler(
        SCHEDULER,
        { every: HOUR_MS },
        { name: "idempotency-sweep" }
      );
      await queue.resume();
    }
  });
});
