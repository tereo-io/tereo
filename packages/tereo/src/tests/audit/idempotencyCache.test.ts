import { withAuditIdempotency } from "../../utils/auditIdempotency.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { getRedisClient } from "../../utils/redis.js";

describe("Audit idempotency once the write has committed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the written result, and keeps the key, when storing it fails", async () => {
    const redis = getRedisClient();
    const realSet = redis.set.bind(redis);
    let sets = 0;
    vi.spyOn(redis, "set").mockImplementation(((...args: unknown[]) => {
      sets++;
      // The first SET is the claim; the second stores the result.
      if (sets === 2) return Promise.reject(new Error("redis went away"));
      return (realSet as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof redis.set);

    let writes = 0;
    const scope = {
      userId: crypto.randomUUID(),
      route: "entries" as const,
      key: crypto.randomUUID(),
      body: { entityId: "x" },
    };
    const write = async () => {
      writes++;
      return { id: "entry-1" };
    };

    // The entry is in the table, so the caller must hear it succeeded: a 500
    // would have it retry and write the entry a second time.
    await expect(withAuditIdempotency(scope, write)).resolves.toEqual({
      id: "entry-1",
    });
    vi.restoreAllMocks();

    await expect(withAuditIdempotency(scope, write)).rejects.toMatchObject({
      statusCode: 409,
      code: "idempotency_request_in_progress",
    });
    expect(writes).toBe(1);
  });
});

describe("Audit idempotency with an unreadable stored value", () => {
  const scopeFor = () => ({
    userId: crypto.randomUUID(),
    route: "entries" as const,
    key: crypto.randomUUID(),
    body: { entityId: "x" },
  });
  const redisKey = (s: ReturnType<typeof scopeFor>) =>
    `audit-log-service:idempotency:${s.userId}:${s.route}:${s.key}`;

  it.each([
    ["not JSON", "{oops"],
    ["JSON without a body hash", JSON.stringify({ result: 1 })],
  ])("treats %s as a miss: drops it and writes", async (_label, value) => {
    const redis = getRedisClient();
    const scope = scopeFor();
    await redis.set(redisKey(scope), value, "EX", 60);

    let writes = 0;
    const write = async () => {
      writes++;
      return { id: "entry-1" };
    };

    await expect(withAuditIdempotency(scope, write)).resolves.toEqual({
      id: "entry-1",
    });
    // The result is stored again, so a repeat replays it.
    await expect(withAuditIdempotency(scope, write)).resolves.toEqual({
      id: "entry-1",
    });
    expect(writes).toBe(1);
    await redis.del(redisKey(scope));
  });
});

describe("Audit idempotency while Redis is unavailable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const scope = () => ({
    userId: crypto.randomUUID(),
    route: "entries" as const,
    key: crypto.randomUUID(),
    body: { entityId: "x" },
  });

  // Refused before anything is written, so a retry cannot duplicate it.
  const expectUnavailable = async (promise: Promise<unknown>) => {
    const err = (await promise.then(
      () => null,
      (e: unknown) => e
    )) as { headers?: Record<string, unknown> } | null;
    expect(err).toMatchObject({
      statusCode: 503,
      code: "temporarily_unavailable",
    });
    expect(Number(err?.headers?.["Retry-After"])).toBeGreaterThan(0);
  };

  it("refuses with 503 while the client is not ready", async () => {
    const redis = getRedisClient() as unknown as { status: string };
    const status = redis.status;
    let writes = 0;
    redis.status = "reconnecting";
    try {
      await expectUnavailable(
        withAuditIdempotency(scope(), async () => writes++)
      );
    } finally {
      redis.status = status;
    }
    expect(writes).toBe(0);
  });

  it("refuses with 503 when claiming the key fails", async () => {
    vi.spyOn(getRedisClient(), "set").mockRejectedValue(
      new Error("connection reset")
    );
    let writes = 0;
    await expectUnavailable(
      withAuditIdempotency(scope(), async () => writes++)
    );
    expect(writes).toBe(0);
  });

  it("writes without a key, needing no Redis", async () => {
    const redis = getRedisClient() as unknown as { status: string };
    const status = redis.status;
    redis.status = "reconnecting";
    try {
      await expect(
        withAuditIdempotency({ ...scope(), key: undefined }, async () => 1)
      ).resolves.toBe(1);
    } finally {
      redis.status = status;
    }
  });
});

describe("Audit idempotency when the write fails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const scopeFor = () => ({
    userId: crypto.randomUUID(),
    route: "entries" as const,
    key: crypto.randomUUID(),
    body: { entityId: "x" },
  });
  const redisKey = (s: ReturnType<typeof scopeFor>) =>
    `audit-log-service:idempotency:${s.userId}:${s.route}:${s.key}`;

  it("releases its claim, so the client can retry", async () => {
    const scope = scopeFor();
    await expect(
      withAuditIdempotency(scope, async () => {
        throw new Error("write failed");
      })
    ).rejects.toThrow("write failed");
    expect(await getRedisClient().get(redisKey(scope))).toBeNull();
  });

  it("leaves a claim another request took once its own expired", async () => {
    const redis = getRedisClient();
    const scope = scopeFor();
    const other = "pending:another-request";
    await expect(
      withAuditIdempotency(scope, async () => {
        // This claim's TTL lapsed mid-write and another request claimed the key.
        await redis.set(redisKey(scope), other, "EX", 60);
        throw new Error("write failed");
      })
    ).rejects.toThrow("write failed");
    expect(await redis.get(redisKey(scope))).toBe(other);
    await redis.del(redisKey(scope));
  });

  it("rethrows the write's error when releasing the claim fails", async () => {
    const redis = getRedisClient();
    vi.spyOn(redis, "del").mockRejectedValue(new Error("redis went away"));
    vi.spyOn(redis, "eval").mockRejectedValue(new Error("redis went away"));
    await expect(
      withAuditIdempotency(scopeFor(), async () => {
        throw new Error("write failed");
      })
    ).rejects.toThrow("write failed");
  });
});
