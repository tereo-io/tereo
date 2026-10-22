// @module-tag unit
// @module-tag auth
import { SetMemberRolesSchema } from "../../../../../../../../../routes/v1/admin/organizations/organization/members/member/roles/schemas.js";
import { describe, expect, it } from "vitest";

describe("PUT /v1/admin/organizations/:id/members/:userId/roles", () => {
  describe("SetMemberRolesSchema", () => {
    it("rejects role ids that are not UUIDs", () => {
      const result = SetMemberRolesSchema.safeParse({ roleIds: [999999] });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["roleIds", 0]);
    });
  });
});
