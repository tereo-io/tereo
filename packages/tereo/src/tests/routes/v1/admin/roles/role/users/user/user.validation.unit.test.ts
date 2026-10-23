// @module-tag unit
// @module-tag auth
import { RemoveRoleUserQuerySchema } from "../../../../../../../../routes/v1/admin/roles/role/users/user/schemas.js";
import { describe, expect, it } from "vitest";

describe("DELETE /v1/admin/roles/:id/users/:userId", () => {
  describe("RemoveRoleUserQuerySchema", () => {
    it("rejects an organizationId that is not a uuid", () => {
      const result = RemoveRoleUserQuerySchema.safeParse({
        organizationId: "nope",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["organizationId"]);
    });
  });
});
