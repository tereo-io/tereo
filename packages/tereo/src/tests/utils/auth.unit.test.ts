// @module-tag unit
// @module-tag auth
import { parseBasicAuth } from "../../utils/auth.js";
import { describe, expect, it } from "vitest";
import type { Request } from "express";

const withAuthorization = (authorization: string) =>
  ({ headers: { authorization } }) as Request;

describe("parseBasicAuth", () => {
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
