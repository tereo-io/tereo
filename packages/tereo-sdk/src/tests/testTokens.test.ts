import { parseTestToken } from "../utils/testTokens.js";
import { describe, expect, it } from "vitest";

describe("parseTestToken", () => {
  it("returns null for non-test tokens", () => {
    expect(parseTestToken("eyJ...", [])).toBeNull();
    expect(parseTestToken("", [])).toBeNull();
  });

  it("parses the basic form with default permissions", () => {
    const result = parseTestToken("test-token-user-1", ["products.read"]);
    expect(result).toMatchObject({
      active: true,
      sub: "user-1",
      user_id: "user-1",
      permissions: ["products.read"],
    });
  });

  it("parses org metadata", () => {
    const result = parseTestToken(
      "test-token-user-1|org=org-a|org_name=Acme",
      []
    );
    expect(result).toMatchObject({
      sub: "user-1",
      org_id: "org-a",
      org_name: "Acme",
    });
  });

  it("parses custom permissions (overrides default)", () => {
    const result = parseTestToken(
      "test-token-user-1|perms=foo.write,bar.read",
      ["default.perm"]
    );
    expect(result?.permissions).toEqual(["foo.write", "bar.read"]);
  });

  it("parses the full form in any order", () => {
    const result = parseTestToken(
      "test-token-user-1|org=org-a|perms=x.admin|org_name=Acme",
      []
    );
    expect(result).toMatchObject({
      sub: "user-1",
      org_id: "org-a",
      org_name: "Acme",
      permissions: ["x.admin"],
    });
  });

  it("returns null when the user id segment is empty", () => {
    expect(parseTestToken("test-token-", [])).toBeNull();
  });
});
