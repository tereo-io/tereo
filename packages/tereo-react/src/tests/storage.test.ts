import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  readJson,
  removeKey,
  subscribeKey,
  useStoredValue,
  writeJson,
} from "../storage.js";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("storage", () => {
  it("re-renders on a write in the same tab", () => {
    const { result } = renderHook(() => useStoredValue<{ n: number }>("k"));
    expect(result.current).toBeNull();

    act(() => writeJson("k", { n: 1 }));
    expect(result.current).toEqual({ n: 1 });

    act(() => removeKey("k"));
    expect(result.current).toBeNull();
  });

  it("re-renders on a storage event from another tab", () => {
    const { result } = renderHook(() => useStoredValue<string>("k"));

    act(() => {
      localStorage.setItem("k", JSON.stringify("other-tab"));
      window.dispatchEvent(new StorageEvent("storage", { key: "k" }));
    });
    expect(result.current).toBe("other-tab");
  });

  it("ignores events for other keys and stops after unsubscribe", () => {
    const fn = vi.fn();
    const off = subscribeKey("k", fn);

    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(fn).not.toHaveBeenCalled();

    off();
    writeJson("k", 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("reads null from a throwing localStorage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readJson("k")).toBeNull();
    const { result } = renderHook(() => useStoredValue("k"));
    expect(result.current).toBeNull();
  });

  it("does not throw when writing to a throwing localStorage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => writeJson("k", 1)).not.toThrow();
  });

  it("reads null for malformed JSON", () => {
    localStorage.setItem("k", "{nope");
    expect(readJson("k")).toBeNull();
  });
});
