// @module-tag unit
// @module-tag auth
import { describe, it, expect } from "vitest";
import {
  TotpRecoverySchema,
  TotpSetupVerifySchema,
  TotpVerifySchema,
} from "../../../../routes/oauth/totp/schemas.js";

describe("POST /oauth/totp/verify", () => {
  describe("TotpVerifySchema", () => {
    it.each([
      ["a missing TOTP code", { session_token: "invalid-session-token" }],
      [
        "a 5-digit TOTP code",
        { session_token: "some-session", totp_code: "12345" },
      ],
      [
        "a non-numeric TOTP code",
        { session_token: "some-session", totp_code: "abcdef" },
      ],
      [
        "a 7-digit TOTP code",
        { session_token: "some-session", totp_code: "1234567" },
      ],
    ])("rejects %s", (_label, input) => {
      const result = TotpVerifySchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["totp_code"]);
    });
  });
});

describe("POST /oauth/totp/recovery", () => {
  describe("TotpRecoverySchema", () => {
    it.each([
      ["a missing recovery code", { session_token: "invalid-session-token" }],
      [
        "an empty recovery code",
        { session_token: "some-session", recovery_code: "" },
      ],
    ])("rejects %s", (_label, input) => {
      const result = TotpRecoverySchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["recovery_code"]);
    });
  });
});

describe("POST /oauth/totp/setup/verify", () => {
  describe("TotpSetupVerifySchema", () => {
    it.each([
      ["a missing totp_code", { setup_token: "invalid-setup-token" }],
      [
        "a 5-digit TOTP code",
        { setup_token: "some-token", totp_code: "12345" },
      ],
      ["an empty totp_code", { setup_token: "some-token", totp_code: "" }],
    ])("rejects %s", (_label, input) => {
      const result = TotpSetupVerifySchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["totp_code"]);
    });
  });
});
