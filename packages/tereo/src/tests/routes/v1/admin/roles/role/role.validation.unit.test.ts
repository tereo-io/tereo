// @module-tag unit
// @module-tag auth
import { SetPermissionsSchema } from "../../../../../../routes/v1/admin/roles/role/schemas.js";
import { describe, expect, it } from "vitest";

const VALID_ID = "00000000-0000-7000-8000-000000000000";

describe("PUT /v1/admin/roles/:id/permissions", () => {
  describe("SetPermissionsSchema", () => {
    it.each([
      [
        "permission ids that are not UUIDs",
        [999998, 999999],
        ["permissionIds", 0],
      ],
      [
        "valid and invalid permission ids mixed",
        [VALID_ID, 999999],
        ["permissionIds", 1],
      ],
    ])("rejects %s", (_label, permissionIds, path) => {
      const result = SetPermissionsSchema.safeParse({ permissionIds });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });
});
