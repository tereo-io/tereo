// @module-tag unit
// @module-tag provisioning
import { describe, it, expect } from "vitest";
import {
  CreateServiceSchema,
  ListServiceAccessQuerySchema,
} from "../../../../../routes/v1/admin/services/schemas.js";

describe("/v1/admin/services", () => {
  describe("CreateServiceSchema", () => {
    it.each([
      [
        "an explicit slug over 64 characters",
        { name: "Too long", slug: `x${"a".repeat(64)}` },
      ],
    ])("rejects %s", (_label, body) => {
      const result = CreateServiceSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["slug"]);
    });
  });

  describe("ListServiceAccessQuerySchema", () => {
    it.each([["maybe"], ["pending"]])("rejects filter[status]=%s", (status) => {
      const result = ListServiceAccessQuerySchema.safeParse({
        "filter[status]": status,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toContain("approved");
    });
  });
});
