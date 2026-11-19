// @module-tag unit
// @module-tag auth
import { SetReportsToSchema } from "../../../../../../../routes/v1/admin/users/user/reports-to/schemas.js";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

describe("PUT /v1/admin/users/:id/reports-to", () => {
  describe("SetReportsToSchema", () => {
    it("accepts a UUID", () => {
      const userId = randomUUID();
      expect(SetReportsToSchema.parse({ userId })).toEqual({ userId });
    });

    it.each([
      ["a missing userId", {}],
      ["a userId that is not a UUID", { userId: "x" }],
      ["a null userId", { userId: null }],
    ])("refuses %s", (_label, body) => {
      const result = SetReportsToSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["userId"]);
    });
  });
});
