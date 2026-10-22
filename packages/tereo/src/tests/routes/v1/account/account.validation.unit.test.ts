// @module-tag unit
// @module-tag auth
import { ChangePasswordSchema } from "../../../../routes/v1/account/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/account/password", () => {
  describe("ChangePasswordSchema", () => {
    it("rejects a weak new password", () => {
      const result = ChangePasswordSchema.safeParse({
        currentPassword: "TestPassword123!",
        newPassword: "weak",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["newPassword"]);
    });
  });
});
