// @module-tag unit
// @module-tag auth
import { describe, it, expect } from "vitest";
import {
  CheckPermissionSchema,
  CheckPermissionsSchema,
} from "../../../../routes/oauth/check-permission/schemas.js";

// RFC-variant-0, like the fixtures' user ids.
const USER_ID = "00000000-0000-7002-0000-000000000001";

describe("POST /oauth/check-permission", () => {
  describe("CheckPermissionSchema", () => {
    it.each([
      ["a missing permission", { user_id: USER_ID }, "permission"],
      [
        "a user_id that is not a uuid",
        { user_id: "not-a-number", permission: "users.read" },
        "user_id",
      ],
    ])("rejects %s", (_label, input, field) => {
      const result = CheckPermissionSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual([field]);
    });
  });
});

describe("POST /oauth/check-permission/batch", () => {
  describe("CheckPermissionsSchema", () => {
    it.each([
      ["a missing permissions field", { user_id: USER_ID }, "permissions"],
      [
        "a batch of more than 100 permissions",
        {
          user_id: USER_ID,
          permissions: Array.from({ length: 101 }, (_, i) => `p${i}.read`),
        },
        "permissions",
      ],
    ])("rejects %s", (_label, input, field) => {
      const result = CheckPermissionsSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual([field]);
    });
  });
});
