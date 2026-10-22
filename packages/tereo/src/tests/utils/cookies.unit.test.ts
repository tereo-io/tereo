// @module-tag unit
// @module-tag auth
import { usesHostPrefix } from "../../utils/cookies.js";
import { describe, expect, it } from "vitest";

describe("usesHostPrefix", () => {
  it("prefixes Secure host-only cookies", () => {
    expect(usesHostPrefix(true, undefined)).toBe(true);
  });

  it("leaves cookies shared through COOKIE_DOMAIN, or sent over http, unprefixed", () => {
    expect(usesHostPrefix(true, "example.com")).toBe(false);
    expect(usesHostPrefix(false, undefined)).toBe(false);
  });
});
