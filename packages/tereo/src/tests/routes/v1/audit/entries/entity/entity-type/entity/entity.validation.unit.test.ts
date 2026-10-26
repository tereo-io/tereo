// @module-tag unit
// @module-tag audit
import { entityParamsSchema } from "../../../../../../../../routes/v1/audit/entries/entity/entity-type/entity/schemas.js";
import { describe, it, expect } from "vitest";

describe("GET /v1/audit/entries/entity/:entityType/:entityId", () => {
  describe("entityParamsSchema", () => {
    it.each([
      [
        "an entityType over 100 characters",
        { entityType: "x".repeat(101), entityId: "some-id" },
      ],
      [
        "an entityId over 500 characters",
        { entityType: "Order", entityId: "x".repeat(501) },
      ],
    ])("rejects %s", (_label, params) => {
      expect(entityParamsSchema.safeParse(params).success).toBe(false);
    });
  });
});
