// @module-tag unit
// @module-tag files
import { describe, expect, it } from "vitest";
import {
  bulkDeleteBodySchema,
  listObjectsQuerySchema,
} from "../../../../../../../routes/v1/files/buckets/bucket/objects/schemas.js";

describe("GET /v1/files/buckets/:name/objects and POST /objects/bulk-delete", () => {
  describe("listObjectsQuerySchema", () => {
    it.each([
      ["a limit over the maximum of 1000", { limit: "1001" }],
      [
        "an objectKey filter longer than a key",
        { "filter[objectKey]": "k".repeat(1025) },
      ],
      [
        "a contentType filter longer than a content type",
        {
          "filter[contentType]": "t".repeat(256),
          "filter[contentType_op]": "contains",
        },
      ],
    ])("rejects %s", (_label, query) => {
      expect(listObjectsQuerySchema.safeParse(query).success).toBe(false);
    });

    it("accepts an objectKey filter as long as a key", () => {
      const result = listObjectsQuerySchema.safeParse({
        "filter[objectKey]": "k".repeat(1024),
      });
      expect(result.success).toBe(true);
    });
  });

  describe("bulkDeleteBodySchema", () => {
    it.each([
      ["an empty prefix", { prefix: "" }],
      ["a body with both forms", { prefix: "a/", ids: [] }],
      ["a body with neither form", {}],
    ])("rejects %s", (_label, body) => {
      expect(bulkDeleteBodySchema.safeParse(body).success).toBe(false);
    });
  });
});
