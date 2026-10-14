import { ifRangeAllows, parseRange } from "../../utils/httpRange.js";
import { describe, expect, it } from "vitest";

describe("parseRange", () => {
  it("reads first-last, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=50-5000", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange(" Bytes = 1-1", 100)).toEqual({ start: 1, end: 1 });
  });

  it("is unsatisfiable past the end, for an empty suffix or empty content", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-5", 0)).toBe("unsatisfiable");
  });

  it("ignores what it doesn't serve: no header, other units, bad specs, several ranges", () => {
    for (const header of [
      undefined,
      "",
      "items=0-1",
      "bytes=",
      "bytes=-",
      "bytes=a-b",
      "bytes=9-2",
      "bytes=0-1,4-5",
      "bytes=99999999999999999999-",
    ]) {
      expect([header, parseRange(header, 100)]).toEqual([header, null]);
    }
  });
});

describe("ifRangeAllows", () => {
  const modified = new Date("2026-10-01T12:00:00.500Z");

  it("allows without the header", () => {
    expect(ifRangeAllows(undefined, "abc")).toBe(true);
  });

  it("matches entity tags strongly", () => {
    expect(ifRangeAllows('"abc"', "abc")).toBe(true);
    expect(ifRangeAllows('"abd"', "abc")).toBe(false);
    expect(ifRangeAllows('W/"abc"', "abc")).toBe(false);
  });

  it("matches a date to the second, and never without a Last-Modified", () => {
    const http = modified.toUTCString();
    expect(ifRangeAllows(http, "abc", modified)).toBe(true);
    expect(ifRangeAllows(new Date(0).toUTCString(), "abc", modified)).toBe(
      false
    );
    expect(ifRangeAllows(http, "abc")).toBe(false);
    expect(ifRangeAllows("not a date", "abc", modified)).toBe(false);
  });
});
