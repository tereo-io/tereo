import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearResetReturn,
  readResetReturn,
  rememberResetReturn,
} from "./resetReturn";

const KEY = "tereo.resetReturnTo";
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resetReturn", () => {
  it("reads back what was remembered, in another tab too", () => {
    rememberResetReturn("?client_id=acme&state=s1");
    // A new tab shares localStorage, not sessionStorage.
    window.sessionStorage.clear();

    expect(readResetReturn()).toBe("?client_id=acme&state=s1");
  });

  it("keeps an empty query", () => {
    rememberResetReturn("");
    expect(readResetReturn()).toBe("");
  });

  it("refuses anything but a query string", () => {
    rememberResetReturn("//evil.example/");
    expect(readResetReturn()).toBeNull();
  });

  it("ignores and removes an entry older than an hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
    rememberResetReturn("?client_id=acme");

    vi.setSystemTime(new Date(Date.now() + HOUR_MS - 1000));
    expect(readResetReturn()).toBe("?client_id=acme");

    vi.setSystemTime(new Date(Date.now() + 2000));
    expect(readResetReturn()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("ignores and removes a malformed entry", () => {
    window.localStorage.setItem(KEY, "?client_id=acme");
    expect(readResetReturn()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("clears", () => {
    rememberResetReturn("?client_id=acme");
    clearResetReturn();
    expect(readResetReturn()).toBeNull();
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => rememberResetReturn("?a=1")).not.toThrow();
    expect(readResetReturn()).toBeNull();
  });
});
