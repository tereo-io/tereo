// @module-tag unit
// @module-tag auth
// @module-tag security
import { describe, expect, it } from "vitest";
import {
  BrandingColorsSchema,
  isSafeColorValue,
} from "../../../utils/branding/colors.js";

describe("isSafeColorValue", () => {
  it.each([
    "#0b5",
    "#0b5f",
    "#00bb55",
    "#00bb55cc",
    "rgb(0, 187, 85)",
    "rgba(0,187,85,0.5)",
    "hsl(150deg 100% 37%)",
    "hsla(150, 100%, 37%, .5)",
    "oklch(0.7 0.18 150 / 50%)",
  ])("accepts %s", (v) => expect(isSafeColorValue(v)).toBe(true));

  it.each([
    "red",
    "red;}body{color:red",
    "url(x)",
    "var(--k-x)",
    "expression(alert(1))",
    "#0b5/**/",
    "rgb(0,0,0);",
    "color-mix(in srgb, red, blue)",
    '"#fff"',
    "#ggg",
    "",
    "rgb(1,2,3)}",
    "rgb()",
    `#${"0".repeat(70)}`,
  ])("rejects %s", (v) => expect(isSafeColorValue(v)).toBe(false));
});

describe("BrandingColorsSchema", () => {
  it("rejects an unknown variable", () =>
    expect(
      BrandingColorsSchema.safeParse({ "--k-made-up": "#fff" }).success
    ).toBe(false));
  it("accepts a known variable", () =>
    expect(
      BrandingColorsSchema.safeParse({ "--k-primary-color": "#fff" }).success
    ).toBe(true));
  it("rejects an unsafe value", () =>
    expect(
      BrandingColorsSchema.safeParse({ "--k-primary-color": "red;}" }).success
    ).toBe(false));
});
