// @module-tag unit
// @module-tag auth
import { bearerToken } from "../../utils/tokens.js";
import { describe, expect, it } from "vitest";

describe("bearerToken", () => {
  it("reads a bearer token whatever the scheme's case", () => {
    for (const scheme of ["Bearer", "bearer", "BEARER", "bEaReR"]) {
      expect(bearerToken(`${scheme} abc.def`), scheme).toBe("abc.def");
    }
  });

  it("refuses a bearer header without a token or with another scheme", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
    expect(bearerToken("Bearerabc")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});
