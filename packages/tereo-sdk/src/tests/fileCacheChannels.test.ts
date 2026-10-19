import { afterEach, describe, expect, it, vi } from "vitest";
import { useCacheRedis } from "../utils/cache.js";
import { EventEmitter } from "node:events";
import {
  closeFileServiceCache,
  startFileServiceCache,
} from "../utils/fileCache.js";

const fakeRedis = () => {
  const subscriber = Object.assign(new EventEmitter(), {
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
  });
  const del = vi.fn(async () => 1);
  return {
    subscriber,
    del,
    redis: { duplicate: () => subscriber, del } as never,
  };
};

afterEach(async () => {
  await closeFileServiceCache();
  useCacheRedis(null);
});

describe("file cache invalidation channels", () => {
  it("subscribes to core's channel names by default", async () => {
    const { subscriber, redis } = fakeRedis();
    useCacheRedis(redis, "@tereo-io/sdk:id");
    await startFileServiceCache();
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      "file-service:bucket-invalidate",
      "file-service:object-invalidate"
    );
  });

  it("puts channelPrefix in front of them and drops entries on its messages", async () => {
    const { subscriber, redis, del } = fakeRedis();
    useCacheRedis(redis, "@tereo-io/sdk:id");
    await startFileServiceCache({ channelPrefix: "app1:" });
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      "app1:file-service:bucket-invalidate",
      "app1:file-service:object-invalidate"
    );

    subscriber.emit("message", "file-service:bucket-invalidate", "photos");
    subscriber.emit("message", "app1:file-service:bucket-invalidate", "docs");
    await vi.waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del).toHaveBeenCalledWith(
      "@tereo-io/sdk:id:file-sdk:v1:bucket:docs"
    );

    await closeFileServiceCache();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(
      "app1:file-service:bucket-invalidate",
      "app1:file-service:object-invalidate"
    );
  });
});
