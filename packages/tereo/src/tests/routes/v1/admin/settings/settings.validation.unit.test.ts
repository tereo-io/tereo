// @module-tag unit
// @module-tag auth
import { UpdateSettingsSchema } from "../../../../../routes/v1/admin/settings/schemas.js";
import { describe, expect, it } from "vitest";

describe("PATCH /v1/admin/settings", () => {
  describe("UpdateSettingsSchema", () => {
    it.each([
      [
        "an invalid TOTP policy value",
        { totpPolicy: "invalid" },
        ["totpPolicy"],
      ],
      [
        "a recovery code count below the minimum",
        { totpRecoveryCodeCount: 2 },
        ["totpRecoveryCodeCount"],
      ],
      [
        "a recovery code count above the maximum",
        { totpRecoveryCodeCount: 25 },
        ["totpRecoveryCodeCount"],
      ],
    ])("rejects %s", (_label, body, path) => {
      const result = UpdateSettingsSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });
});
