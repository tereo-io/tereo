// @module-tag unit
// @module-tag auth
import { AccountOrganizationsSearchSchema } from "../../../../../routes/v1/account/organizations/schemas.js";
import { describe, expect, it } from "vitest";

describe("GET /v1/account/organizations", () => {
  describe("AccountOrganizationsSearchSchema", () => {
    it("rejects a search shorter than two characters", () => {
      const result = AccountOrganizationsSearchSchema.safeParse({
        search: "a",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["search"]);
    });
  });
});
