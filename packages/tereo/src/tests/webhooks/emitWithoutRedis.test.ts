import { emitWithIdempotency } from "../../utils/processEvent.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { getRedisClient } from "../../utils/redis.js";
import { AppError } from "../../utils/errors.js";

/**
 * An emit with an idempotency key needs Redis to claim the key. Without it the
 * emit is refused with 503 `temporarily_unavailable` and a Retry-After, not
 * left waiting on a reconnect or failed with a 500. Runs against this
 * worker's Redis client, which is made not ready or made to throw.
 */

const event = () => ({
  organizationId: crypto.randomUUID(),
  eventType: "emit-without-redis.event",
  entityType: "TestEntity",
  entityId: crypto.randomUUID(),
  data: {},
  idempotencyKey: `key-${crypto.randomUUID()}`,
});

const expectUnavailable = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(AppError);
  const appErr = err as AppError & { headers?: Record<string, unknown> };
  expect(appErr.statusCode).toBe(503);
  expect(appErr.code).toBe("temporarily_unavailable");
  expect(Number(appErr.headers?.["Retry-After"])).toBeGreaterThan(0);
};

describe("emit with an idempotency key while Redis is unavailable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses with 503 while the client is not ready", async () => {
    const redis = getRedisClient() as unknown as { status: string };
    const status = redis.status;
    redis.status = "reconnecting";
    try {
      await expectUnavailable(emitWithIdempotency(event(), SYSTEM_USER_ID));
    } finally {
      redis.status = status;
    }
  });

  it("refuses with 503 when a Redis command fails", async () => {
    vi.spyOn(getRedisClient(), "set").mockRejectedValue(
      new Error("connection reset")
    );
    await expectUnavailable(emitWithIdempotency(event(), SYSTEM_USER_ID));
  });
});
