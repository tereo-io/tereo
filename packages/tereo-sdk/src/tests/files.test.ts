import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileServiceClient } from "../clients/files.js";
import { FileCache } from "../utils/fileCache.js";
import { useCacheRedis } from "../utils/cache.js";
import type { Redis } from "ioredis";

const { mockRedis, mockRequests } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    mockRedis: {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
      del: vi.fn(async (...keys: string[]) => {
        for (const k of keys) store.delete(k);
        return keys.length;
      }),
    },
    mockRequests: {
      files: {
        getBucket: vi.fn(),
        updateBucket: vi.fn(),
        transferBucketOwnership: vi.fn(),
        patchObject: vi.fn(),
        deleteObject: vi.fn(),
      },
    },
  };
});

vi.mock("../handler.js", () => ({
  requests: mockRequests,
  getOriginalStatus: vi.fn(
    (err: unknown) => (err as { originalStatus?: number })?.originalStatus
  ),
}));

beforeEach(() => {
  useCacheRedis(mockRedis as unknown as Redis);
  mockRedis.store.clear();
  vi.clearAllMocks();
  delete process.env.NODE_ENV;
});

describe("FileServiceClient", () => {
  it("constructs without touching Redis", () => {
    expect(() => new FileServiceClient()).not.toThrow();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it("caches getBucket under file-sdk:bucket:{name}", async () => {
    mockRequests.files.getBucket.mockResolvedValueOnce({
      name: "b1",
      policy: "private",
    });
    const client = new FileServiceClient();

    const first = await client.getBucket("b1");
    const second = await client.getBucket("b1");

    expect(first).toMatchObject({ name: "b1" });
    expect(second).toMatchObject({ name: "b1" });
    expect(mockRequests.files.getBucket).toHaveBeenCalledTimes(1);
    expect(mockRedis.store.has("file-sdk:v1:bucket:b1")).toBe(true);
  });

  it("getBucket returns null on 404", async () => {
    mockRequests.files.getBucket.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { originalStatus: 404 })
    );
    const client = new FileServiceClient();
    const result = await client.getBucket("missing");
    expect(result).toBeNull();
  });

  it("updateBucket invalidates bucket cache", async () => {
    mockRedis.store.set(
      "file-sdk:v1:bucket:b1",
      JSON.stringify({ name: "b1" })
    );
    mockRequests.files.updateBucket.mockResolvedValueOnce({
      name: "b1",
      policy: "public",
    });
    const client = new FileServiceClient();
    await client.updateBucket("b1", { policy: "public" });
    expect(mockRedis.store.has("file-sdk:v1:bucket:b1")).toBe(false);
  });

  it("transferBucketOwnership sends the user and invalidates bucket cache", async () => {
    mockRedis.store.set(
      "file-sdk:v1:bucket:b1",
      JSON.stringify({ name: "b1" })
    );
    mockRequests.files.transferBucketOwnership.mockResolvedValueOnce({
      name: "b1",
      ownerId: "u2",
    });
    const client = new FileServiceClient();
    const bucket = await client.transferBucketOwnership("b1", "u2");
    expect(mockRequests.files.transferBucketOwnership).toHaveBeenCalledWith(
      "b1",
      "u2"
    );
    expect(bucket.ownerId).toBe("u2");
    expect(mockRedis.store.has("file-sdk:v1:bucket:b1")).toBe(false);
  });

  it("patchObject drops the cached metadata for the resulting key", async () => {
    mockRedis.store.set("file-sdk:v1:object:b1/new.txt", "{}");
    mockRedis.store.set("file-sdk:v1:object:b1/other.txt", "{}");
    mockRequests.files.patchObject.mockResolvedValueOnce({
      id: "obj-1",
      key: "new.txt",
    });
    const client = new FileServiceClient();

    const result = await client.patchObject("b1", "obj-1", {
      objectKey: "new.txt",
    });

    expect(result).toMatchObject({ key: "new.txt" });
    expect(mockRedis.store.has("file-sdk:v1:object:b1/new.txt")).toBe(false);
    expect(mockRedis.store.has("file-sdk:v1:object:b1/other.txt")).toBe(true);
  });
});

describe("FileServiceClient.deleteObject", () => {
  it("resolves when core answers 404", async () => {
    mockRequests.files.deleteObject.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { originalStatus: 404 })
    );
    await expect(
      new FileServiceClient().deleteObject("b1", "obj-1")
    ).resolves.toBeUndefined();
  });

  it.each([403, 500])("rejects when core answers %i", async (status) => {
    const error = Object.assign(new Error("failed"), {
      originalStatus: status,
    });
    mockRequests.files.deleteObject.mockRejectedValueOnce(error);
    await expect(
      new FileServiceClient().deleteObject("b1", "obj-1")
    ).rejects.toBe(error);
  });
});

describe("FileCache", () => {
  it("del accepts variadic keys", async () => {
    const cache = new FileCache();
    mockRedis.store.set("file-sdk:v1:a", "1");
    mockRedis.store.set("file-sdk:v1:b", "2");
    await cache.del("a", "b");
    expect(mockRedis.store.has("file-sdk:v1:a")).toBe(false);
    expect(mockRedis.store.has("file-sdk:v1:b")).toBe(false);
  });
});
