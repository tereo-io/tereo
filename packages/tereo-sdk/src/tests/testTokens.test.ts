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

  it("names a client with |client=", () => {
    expect(parseTestToken("test-token-u1|client=billing", [])?.client_id).toBe(
      "billing"
    );
    expect(parseTestToken("test-token-u1", [])?.client_id).toBe("test-client");
  });

  it("resolves the service user to the given UUID", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const result = parseTestToken("test-token-service", [], {
      serviceUserId: id,
    });
    expect(result).toMatchObject({ sub: id, user_id: id });
    expect(parseTestToken("test-token-service", [])?.user_id).toBe("service");
    expect(
      parseTestToken("test-token-u1", [], { serviceUserId: id })?.user_id
    ).toBe("u1");
  });
});
