// @module-tag unit
// @module-tag files
import { patchObjectBodySchema } from "../../../../../../../../../routes/v1/files/buckets/bucket/objects/by-id/object/schemas.js";
import { describe, expect, it } from "vitest";

describe("PATCH /v1/files/buckets/:name/objects/by-id/:id", () => {
  describe("patchObjectBodySchema", () => {
    it.each([
      [
        "more than 100 keys",
        Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`key${i}`, "value"])
        ),
      ],
      [
        "more than 100 KB as JSON",
        { blob: Array(20).fill("x".repeat(10_000)) },
      ],
      ["a nested object", { nested: { a: 1 } }],
    ])("rejects metadata with %s", (_label, metadata) => {
      expect(patchObjectBodySchema.safeParse({ metadata }).success).toBe(false);
    });

    it("accepts metadata of strings, numbers and arrays of booleans and nulls", () => {
      const metadata = { reviewed: "yes", count: 2, flags: [true, null] };
      const result = patchObjectBodySchema.safeParse({ metadata });
      expect(result.success).toBe(true);
      expect(result.data?.metadata).toEqual(metadata);
    });
  });
});
