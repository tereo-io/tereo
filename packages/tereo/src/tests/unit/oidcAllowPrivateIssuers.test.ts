import { checkOidcAllowPrivateIssuers } from "../../env.js";
import { describe, expect, it } from "vitest";

describe("checkOidcAllowPrivateIssuers", () => {
  it("refuses it in production", () => {
    expect(checkOidcAllowPrivateIssuers(true, "production")).toBe(
      "OIDC_ALLOW_PRIVATE_ISSUERS cannot be set in production"
    );
  });

  it("allows it outside production", () => {
    expect(checkOidcAllowPrivateIssuers(true, "development")).toBeUndefined();
    expect(checkOidcAllowPrivateIssuers(true, "test")).toBeUndefined();
  });

  it("allows it off in production", () => {
    expect(checkOidcAllowPrivateIssuers(false, "production")).toBeUndefined();
  });
});
