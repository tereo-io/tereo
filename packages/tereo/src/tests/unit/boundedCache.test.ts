import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedCache } from "../../utils/boundedCache.js";

describe("BoundedCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never holds more than its cap, evicting the least recently used", () => {
    const cache = new BoundedCache<number>(3, 60_000);
    for (let i = 0; i < 1000; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(3);

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("expires entries after the TTL", () => {
    vi.useFakeTimers();
    const cache = new BoundedCache<string>(10, 1000);
    cache.set("a", "x");
    vi.advanceTimersByTime(999);
    expect(cache.get("a")).toBe("x");
    vi.advanceTimersByTime(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("caches null values as hits", () => {
    const cache = new BoundedCache<string | null>(10, 1000);
    cache.set("missing", null);
    expect(cache.get("missing")).toBeNull();
  });
});
