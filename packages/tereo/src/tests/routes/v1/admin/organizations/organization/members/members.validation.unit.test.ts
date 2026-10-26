// @module-tag unit
// @module-tag auth
import { AddMemberSchema } from "../../../../../../../routes/v1/admin/organizations/organization/members/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/admin/organizations/:id/members", () => {
  describe("AddMemberSchema", () => {
    it("rejects an invalid memberRole", () => {
      const result = AddMemberSchema.safeParse({
        userId: "00000000-0000-7000-8000-000000000000",
        memberRole: "superadmin",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["memberRole"]);
    });
  });
});
