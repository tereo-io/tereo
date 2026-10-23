// @module-tag unit
// @module-tag audit
import { entryParamsSchema } from "../../../../../../routes/v1/audit/entries/entry/schemas.js";
import { describe, it, expect } from "vitest";

describe("GET /v1/audit/entries/:id", () => {
  describe("entryParamsSchema", () => {
    it.each([["an id that is not a uuid", { id: "not-a-uuid" }]])(
      "rejects %s",
      (_label, params) => {
        expect(entryParamsSchema.safeParse(params).success).toBe(false);
      }
    );
  });
});
