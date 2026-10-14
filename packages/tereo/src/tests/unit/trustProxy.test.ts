import { checkTrustProxy } from "../../env.js";
import { describe, expect, it } from "vitest";

describe("checkTrustProxy", () => {
  it.each([undefined, ""])("refuses %j in production", (value) => {
    expect(checkTrustProxy(value, "production")).toMatch(/must be set/);
  });

  it.each(["1", "10.0.0.0/8", "loopback", "false"])(
    "accepts an explicit %s in production",
    (value) => {
      expect(checkTrustProxy(value, "production")).toBeUndefined();
    }
  );

  it("refuses true in production", () => {
    expect(checkTrustProxy("true", "production")).toMatch(/cannot be 'true'/);
  });

  it("allows it unset or true outside production", () => {
    expect(checkTrustProxy("true", "development")).toBeUndefined();
    expect(checkTrustProxy(undefined, "development")).toBeUndefined();
    expect(checkTrustProxy(undefined, "test")).toBeUndefined();
  });
});
