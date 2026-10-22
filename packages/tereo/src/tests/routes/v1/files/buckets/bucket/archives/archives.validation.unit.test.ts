// @module-tag unit
// @module-tag files
import { createArchiveBodySchema } from "../../../../../../../routes/v1/files/buckets/bucket/archives/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/files/buckets/:name/archives", () => {
  describe("createArchiveBodySchema", () => {
    it("rejects a request with both prefix and keys", () => {
      const body = { prefix: "docs/", keys: ["top-level.txt"] };
      expect(createArchiveBodySchema.safeParse(body).success).toBe(false);
    });
  });
});
