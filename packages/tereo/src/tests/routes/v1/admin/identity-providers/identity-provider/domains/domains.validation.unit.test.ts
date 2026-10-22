// @module-tag unit
// @module-tag auth
import { CreateDomainSchema } from "../../../../../../../routes/v1/admin/identity-providers/identity-provider/domains/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/admin/identity-providers/:id/domains", () => {
  describe("CreateDomainSchema", () => {
    it("rejects a malformed domain", () => {
      const result = CreateDomainSchema.safeParse({
        domain: "not a domain",
        organizationId: "00000000-0000-7000-8000-000000000000",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["domain"]);
    });
  });
});
