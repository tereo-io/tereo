import { isSafeColorValue } from "./colorValue";
import { describe, expect, it } from "vitest";

describe("isSafeColorValue", () => {
  it.each([
    "#fff",
    "#17257d",
    "rgb(1 2 3)",
    "rgba(1, 2, 3, 0.5)",
    "oklch(0.6 0.2 -30)",
    "hsl(-10deg 50% 50%)",
  ])("accepts %s", (value) => expect(isSafeColorValue(value)).toBe(true));
  it.each([
    "rgb(e)",
    "rgb(deg)",
    "rgb(--1 2 3)",
    "url(//evil.com/a)",
    "red;}",
    "rgb(1 2 3) x",
  ])("rejects %s", (value) => expect(isSafeColorValue(value)).toBe(false));
});
