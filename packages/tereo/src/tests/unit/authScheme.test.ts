import { parseBasicAuth } from "../../utils/auth.js";
import { bearerToken } from "../../utils/tokens.js";
import { describe, expect, it } from "vitest";
import type { Request } from "express";

const withAuthorization = (authorization: string) =>
  ({ headers: { authorization } }) as Request;

describe("Authorization schemes", () => {
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

  it("reads Basic credentials whatever the scheme's case", () => {
    const encoded = Buffer.from("client:secret").toString("base64");
    for (const scheme of ["Basic", "basic", "BASIC"]) {
      expect(
        parseBasicAuth(withAuthorization(`${scheme} ${encoded}`)),
        scheme
      ).toEqual({ clientId: "client", clientSecret: "secret" });
    }
    expect(parseBasicAuth(withAuthorization(`Bearer ${encoded}`))).toBeNull();
  });
});
