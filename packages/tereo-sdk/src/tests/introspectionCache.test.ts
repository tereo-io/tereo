import { AuthServiceClient, introspectionCacheTtl } from "../clients/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCacheRedis } from "../utils/cache.js";
import type { Redis } from "ioredis";

const { tryHandleRequest, mockRedis } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    tryHandleRequest: vi.fn(),
    mockRedis: {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, ..._expiry: unknown[]) => {
        store.set(key, value);
        return "OK";
      }),
    },
  };
});
vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest }));

describe("introspectionCacheTtl", () => {
  const now = 1_700_000_000_000;
  const nowSec = now / 1000;

  it("caches for the usual minute when the token outlives it", () => {
    expect(introspectionCacheTtl(nowSec + 3600, now)).toBe(60);
  });

  it("never past the token's exp", () => {
    expect(introspectionCacheTtl(nowSec + 5, now)).toBe(5);
  });

  it("not at all for a token at or past its exp", () => {
    expect(introspectionCacheTtl(nowSec, now)).toBe(0);
    expect(introspectionCacheTtl(nowSec - 10, now)).toBe(0);
  });

  it("never past the configured maximum", () => {
    expect(introspectionCacheTtl(nowSec + 3600, now, 10)).toBe(10);
    expect(introspectionCacheTtl(nowSec + 3600, now, 0)).toBe(0);
  });
});

describe("AuthServiceClient introspection cache", () => {
  const active = () => ({
    active: true,
    iss: "core",
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: 0,
    jti: "j",
    scope: "",
    client_id: "client-1",
  });

  beforeEach(() => {
    useCacheRedis(mockRedis as unknown as Redis);
    mockRedis.store.clear();
    vi.clearAllMocks();
    tryHandleRequest.mockImplementation(async () => ({ data: active() }));
  });

  it("caches an active token for 60 s by default", async () => {
    const client = new AuthServiceClient();
    await client.introspectToken("a");
    await client.introspectToken("a");
    expect(tryHandleRequest).toHaveBeenCalledTimes(1);
    expect(mockRedis.set.mock.calls[0][3]).toBe(60);
  });

  it("caches for the configured seconds", async () => {
    const client = new AuthServiceClient({ introspectionCacheTtlSeconds: 15 });
    await client.introspectToken("b");
    expect(mockRedis.set.mock.calls[0][3]).toBe(15);
  });

  it("asks core on every request when set to 0", async () => {
    const client = new AuthServiceClient({ introspectionCacheTtlSeconds: 0 });
    await client.introspectToken("c");
    await client.introspectToken("c");
    expect(tryHandleRequest).toHaveBeenCalledTimes(2);
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it("refuses a maximum above 300 s, or below 0", () => {
    expect(
      () => new AuthServiceClient({ introspectionCacheTtlSeconds: 301 })
    ).toThrow(/between 0 and 300/);
    expect(
      () => new AuthServiceClient({ introspectionCacheTtlSeconds: -1 })
    ).toThrow(/between 0 and 300/);
    expect(
      () => new AuthServiceClient({ introspectionCacheTtlSeconds: 300 })
    ).not.toThrow();
  });
});
