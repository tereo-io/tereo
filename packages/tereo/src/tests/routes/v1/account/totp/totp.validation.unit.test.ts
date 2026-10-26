// @module-tag unit
// @module-tag auth
import { VerifySetupSchema } from "../../../../../routes/v1/account/totp/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/account/totp/setup/verify", () => {
  describe("VerifySetupSchema", () => {
    it.each([
      ["a missing setup token", { totpCode: "123456" }, ["setupToken"]],
      ["a missing TOTP code", { setupToken: "test-token" }, ["totpCode"]],
    ])("rejects %s", (_label, body, path) => {
      const result = VerifySetupSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });
});
