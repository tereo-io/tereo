// @module-tag unit
// @module-tag notifications
import { isAllowedSender } from "../../../utils/notifications/addresses.js";
import { describe, it, expect } from "vitest";

describe("isAllowedSender", () => {
  it("matches an exact address case-insensitively", () => {
    expect(isAllowedSender("Billing@Acme.com", ["billing@acme.com"])).toBe(
      true
    );
  });
  it("matches a whole domain with @domain", () => {
    expect(isAllowedSender("x@acme.com", ["@acme.com"])).toBe(true);
  });
  it("does not match subdomains or suffixed domains", () => {
    expect(isAllowedSender("x@sub.acme.com", ["@acme.com"])).toBe(false);
    expect(isAllowedSender("x@acme.com.evil", ["@acme.com"])).toBe(false);
  });
  it("matches nothing against an empty list", () => {
    expect(isAllowedSender("x@acme.com", [])).toBe(false);
  });
});
