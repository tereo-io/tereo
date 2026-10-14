import { resolveCookieSecure } from "../../env.js";
import { describe, expect, it } from "vitest";

describe("resolveCookieSecure", () => {
  it("defaults to true in production", () => {
    expect(resolveCookieSecure(undefined, "production")).toBe(true);
    expect(resolveCookieSecure("", "production")).toBe(true);
  });

  it("defaults to false outside production", () => {
    expect(resolveCookieSecure(undefined, "development")).toBe(false);
    expect(resolveCookieSecure(undefined, "test")).toBe(false);
    expect(resolveCookieSecure(undefined, undefined)).toBe(false);
  });

  it("lets an explicit value win", () => {
    expect(resolveCookieSecure("false", "production")).toBe(false);
    expect(resolveCookieSecure("0", "production")).toBe(false);
    expect(resolveCookieSecure("true", "development")).toBe(true);
    expect(resolveCookieSecure("1", "test")).toBe(true);
  });
});
