// @module-tag unit
// @module-tag auth
import { canResetPassword } from "../../utils/passwordReset.js";
import { describe, expect, it } from "vitest";

const human = {
  isActive: true,
  expiresAt: null,
  userType: "human" as const,
};

describe("canResetPassword", () => {
  it.each([
    ["a usable human", human, false, true],
    [
      "an unexpired guest",
      {
        ...human,
        userType: "guest" as const,
        expiresAt: new Date(Date.now() + 60_000),
      },
      false,
      true,
    ],
    [
      "an expired guest",
      {
        ...human,
        userType: "guest" as const,
        expiresAt: new Date(Date.now() - 60_000),
      },
      false,
      false,
    ],
    ["a deactivated user", { ...human, isActive: false }, false, false],
    [
      "a service account",
      { ...human, userType: "service_account" as const },
      false,
      false,
    ],
    ["a provider-only human with no password", human, false, true],
    ["a user on an SSO-only domain", human, true, false],
  ])("%s", (_name, user, ssoOnly, expected) => {
    expect(canResetPassword(user, ssoOnly)).toBe(expected);
  });
});
