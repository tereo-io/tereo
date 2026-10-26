// @module-tag unit
// @module-tag auth
import { UpdateMemberRoleSchema } from "../../../../../../../../routes/v1/admin/organizations/organization/members/member/schemas.js";
import { describe, expect, it } from "vitest";

describe("PATCH /v1/admin/organizations/:id/members/:userId", () => {
  describe("UpdateMemberRoleSchema", () => {
    it("rejects an invalid memberRole", () => {
      const result = UpdateMemberRoleSchema.safeParse({
        memberRole: "invalid",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["memberRole"]);
    });
  });
});
