// @module-tag unit
// @module-tag auth
import { CreateOrganizationSchema } from "../../../../../routes/v1/admin/organizations/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/admin/organizations", () => {
  describe("CreateOrganizationSchema", () => {
    it.each([
      [
        "an invalid slug format",
        { name: "Test", slug: "INVALID_SLUG!", code: "ABC" },
        ["slug"],
      ],
      [
        "an invalid code format",
        { name: "Test", slug: "valid-slug", code: "toolong1" },
        ["code"],
      ],
    ])("rejects %s", (_label, body, path) => {
      const result = CreateOrganizationSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });
});
