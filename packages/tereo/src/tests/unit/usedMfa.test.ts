import { usedMfa } from "../../utils/authorization.js";
import { describe, expect, it } from "vitest";

describe("usedMfa", () => {
  it("counts the mfa marker a provider's own second factor leaves", () => {
    expect(usedMfa(["fed", "mfa"])).toBe(true);
  });

  it("does not count a federated login alone", () => {
    expect(usedMfa(["fed"])).toBe(false);
  });

  it("counts a password followed by a TOTP", () => {
    expect(usedMfa(["pwd", "otp"])).toBe(true);
  });
});
