// @module-tag unit
// @module-tag platform
import { trimTrailing } from "../../utils/strings.js";
import { describe, expect, it } from "vitest";

describe("trimTrailing", () => {
  it("drops every trailing copy of the character", () => {
    expect(trimTrailing("/a/b///", "/")).toBe("/a/b");
    expect(trimTrailing("abc==", "=")).toBe("abc");
  });

  it("leaves a string without one as it is", () => {
    expect(trimTrailing("/a/b", "/")).toBe("/a/b");
    expect(trimTrailing("", "/")).toBe("");
  });

  it("trims a string of nothing else to empty", () => {
    expect(trimTrailing("////", "/")).toBe("");
  });

  it("is linear on a long run that is not at the end", () => {
    const input = `/${"/".repeat(200_000)}x`;
    const started = performance.now();
    expect(trimTrailing(input, "/")).toBe(input);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
