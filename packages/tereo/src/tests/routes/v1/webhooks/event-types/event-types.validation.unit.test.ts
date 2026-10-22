// @module-tag unit
// @module-tag webhooks
import { getEventTypesQuerySchema } from "../../../../../routes/v1/webhooks/event-types/schemas.js";
import { describe, it, expect } from "vitest";

describe("/v1/webhooks/event-types", () => {
  describe("getEventTypesQuerySchema", () => {
    it.each([
      [
        "a NUL in filter[eventType]",
        { "filter[eventType]": "\u0000", "filter[eventType_op]": "contains" },
      ],
      ["a NUL in filter[source]", { "filter[source]": "\u0000" }],
      [
        "a filter value over 500 characters",
        { "filter[source]": "s".repeat(501) },
      ],
    ])("rejects %s", (_label, query) => {
      expect(getEventTypesQuerySchema.safeParse(query).success).toBe(false);
    });

    it("rejects filter[eventType] with no operator, since only contains is allowed", () => {
      const result = getEventTypesQuerySchema.safeParse({
        "filter[eventType]": "x",
      });
      expect(result.error?.issues[0]).toMatchObject({
        path: ["filter[eventType_op]"],
        message: expect.stringContaining("not allowed"),
      });
    });

    it("names the NUL in filter[source]", () => {
      const result = getEventTypesQuerySchema.safeParse({
        "filter[source]": "\u0000",
      });
      expect(result.error?.issues[0]).toMatchObject({
        path: ["filter[source]"],
        message: "must not contain a NUL character",
      });
    });

    it("accepts a filter value of 500 characters", () => {
      const result = getEventTypesQuerySchema.safeParse({
        "filter[source]": "s".repeat(500),
      });
      expect(result.success).toBe(true);
    });
  });
});
