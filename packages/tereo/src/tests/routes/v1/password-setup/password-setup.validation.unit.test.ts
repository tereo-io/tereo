// @module-tag unit
// @module-tag auth
import { describe, it, expect } from "vitest";
import {
  InspectPasswordSetupSchema,
  SetPasswordSchema,
} from "../../../../routes/v1/password-setup/schemas.js";

describe("password setup bodies", () => {
  describe("InspectPasswordSetupSchema", () => {
    it("accepts a token", () => {
      expect(
        InspectPasswordSetupSchema.safeParse({ token: "abc" }).success
      ).toBe(true);
    });

    it.each([
      ["a missing token", {}],
      ["an empty token", { token: "" }],
      ["a token over 128 characters", { token: "a".repeat(129) }],
    ])("rejects %s", (_label, input) => {
      expect(InspectPasswordSetupSchema.safeParse(input).success).toBe(false);
    });

    it("accepts a token of exactly 128 characters", () => {
      expect(
        InspectPasswordSetupSchema.safeParse({ token: "a".repeat(128) }).success
      ).toBe(true);
    });
  });

  describe("SetPasswordSchema", () => {
    const body = { token: "abc", password: "SetupPassword123!" };

    it("accepts a token and a valid password", () => {
      expect(SetPasswordSchema.safeParse(body).success).toBe(true);
    });

    it.each([
      ["a missing token", { password: body.password }],
      ["a token over 128 characters", { ...body, token: "a".repeat(129) }],
      ["a missing password", { token: "abc" }],
      ["a password that is too short", { ...body, password: "short" }],
    ])("rejects %s", (_label, input) => {
      expect(SetPasswordSchema.safeParse(input).success).toBe(false);
    });
  });
});
