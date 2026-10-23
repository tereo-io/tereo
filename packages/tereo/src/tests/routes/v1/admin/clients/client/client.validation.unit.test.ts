// @module-tag unit
// @module-tag auth
import { UpdateClientSchema } from "../../../../../../routes/v1/admin/clients/client/schemas.js";
import { describe, expect, it } from "vitest";

describe("PATCH /v1/admin/clients/:id", () => {
  describe("UpdateClientSchema", () => {
    it("rejects an empty grantTypes", () => {
      const result = UpdateClientSchema.safeParse({ grantTypes: [] });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["grantTypes"]);
    });
  });
});
