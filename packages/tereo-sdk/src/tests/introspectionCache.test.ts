import { introspectionCacheTtl } from "../clients/auth.js";
import { describe, expect, it } from "vitest";

describe("introspectionCacheTtl", () => {
  const now = 1_700_000_000_000;
  const nowSec = now / 1000;

  it("caches for the usual minute when the token outlives it", () => {
    expect(introspectionCacheTtl(nowSec + 3600, now)).toBe(60);
  });

  it("never past the token's exp", () => {
    expect(introspectionCacheTtl(nowSec + 5, now)).toBe(5);
  });

  it("not at all for a token at or past its exp", () => {
    expect(introspectionCacheTtl(nowSec, now)).toBe(0);
    expect(introspectionCacheTtl(nowSec - 10, now)).toBe(0);
  });
});
