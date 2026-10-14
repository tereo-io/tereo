import { computeChanges, deepEqual } from "../utils/audit.js";
import { describe, expect, it } from "vitest";

describe("deepEqual", () => {
  it("matches identical primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
  });

  it("rejects mismatched primitives", () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("compares Dates by epoch", () => {
    expect(deepEqual(new Date("2026-01-01"), new Date("2026-01-01"))).toBe(
      true
    );
    expect(deepEqual(new Date("2026-01-01"), new Date("2026-01-02"))).toBe(
      false
    );
  });

  it("compares arrays element-wise", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
  });

  it("compares plain objects deeply", () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toBe(false);
  });
});

describe("computeChanges", () => {
  it("returns undefined when nothing changed", () => {
    expect(computeChanges({ a: 1 }, { a: 1 })).toBeUndefined();
  });

  it("captures changed fields with old + new", () => {
    expect(computeChanges({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({
      b: { old: 2, new: 3 },
    });
  });

  it("captures added and removed fields", () => {
    expect(computeChanges({ a: 1 }, { a: 1, b: 2 })).toEqual({
      b: { old: undefined, new: 2 },
    });
    expect(computeChanges({ a: 1, b: 2 }, { a: 1 })).toEqual({
      b: { old: 2, new: undefined },
    });
  });

  it("ignores createdAt/updatedAt/deletedAt/archivedAt timestamps", () => {
    expect(
      computeChanges(
        {
          name: "x",
          createdAt: "old",
          updatedAt: "old",
          deletedAt: null,
          archivedAt: null,
        },
        {
          name: "x",
          createdAt: "new",
          updatedAt: "new",
          deletedAt: "new",
          archivedAt: "new",
        }
      )
    ).toBeUndefined();
  });
});
