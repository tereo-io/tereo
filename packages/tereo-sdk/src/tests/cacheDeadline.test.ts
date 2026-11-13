import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthServiceClient } from "../clients/auth.js";
import type { Redis } from "ioredis";
import {
  CACHE_COMMAND_TIMEOUT_MS,
  safeCacheDel,
  safeCacheGet,
  safeCacheSet,
  useCacheRedis,
} from "../utils/cache.js";

const { tryHandleRequest } = vi.hoisted(() => ({ tryHandleRequest: vi.fn() }));
vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest }));

// What ioredis does with a command while it reconnects to a Redis that is
// down, given `maxRetriesPerRequest: null`: it neither answers nor fails.
const never = () => new Promise<never>(() => undefined);
const unreachable = {
  get: vi.fn(never),
  set: vi.fn(never),
  del: vi.fn(never),
};

const settledWithin = async <T>(promise: Promise<T>, ms: number) => {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(ms);
  return { settled, result: settled ? await tracked : undefined };
};

beforeEach(() => {
  vi.useFakeTimers();
  tryHandleRequest.mockReset();
  useCacheRedis(unreachable as unknown as Redis, "svc");
});

afterEach(() => {
  vi.useRealTimers();
  useCacheRedis(null);
});

describe("cache commands against a Redis that does not answer", () => {
  it("waits for a command up to the deadline", async () => {
    const pending = await settledWithin(
      safeCacheGet("k"),
      CACHE_COMMAND_TIMEOUT_MS - 1
    );
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
  });

  it("treats a read past the deadline as a miss", async () => {
    const { settled, result } = await settledWithin(
      safeCacheGet("k"),
      CACHE_COMMAND_TIMEOUT_MS
    );
    expect(settled).toBe(true);
    expect(result).toBeUndefined();
  });

  it("gives up on a write or a delete past the deadline", async () => {
    const write = await settledWithin(
      safeCacheSet("k", { a: 1 }, 60),
      CACHE_COMMAND_TIMEOUT_MS
    );
    const del = await settledWithin(
      safeCacheDel("k"),
      CACHE_COMMAND_TIMEOUT_MS
    );
    expect(write.settled).toBe(true);
    expect(del.settled).toBe(true);
  });

  it("lets introspection fall through to core instead of waiting on Redis", async () => {
    const answer = {
      active: true,
      sub: "user-1",
      exp: Math.floor(Date.now() / 1000) + 3600,
      client_id: "client-1",
    };
    tryHandleRequest.mockResolvedValue({ data: answer });

    const { settled, result } = await settledWithin(
      new AuthServiceClient().introspectToken("tok"),
      2 * CACHE_COMMAND_TIMEOUT_MS
    );

    expect(settled).toBe(true);
    expect(result).toEqual(answer);
    expect(tryHandleRequest).toHaveBeenCalledTimes(1);
  });
});

describe("cache commands against a Redis that answers", () => {
  it("returns what Redis holds, as before", async () => {
    const store = new Map([["svc:k", JSON.stringify({ a: 1 })]]);
    useCacheRedis(
      {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
      } as unknown as Redis,
      "svc"
    );
    expect(await safeCacheGet("k")).toEqual({ a: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
