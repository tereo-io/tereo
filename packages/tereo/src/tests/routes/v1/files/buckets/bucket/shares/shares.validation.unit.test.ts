// @module-tag unit
// @module-tag files
import { describe, expect, it } from "vitest";
import {
  createShareBodySchema,
  listSharesQuerySchema,
} from "../../../../../../../routes/v1/files/buckets/bucket/shares/schemas.js";

describe("GET and POST /v1/files/buckets/:name/shares", () => {
  describe("createShareBodySchema", () => {
    it("rejects an ARCHIVE share with both prefix and keys", () => {
      const body = { kind: "ARCHIVE", prefix: "docs/", keys: ["report.pdf"] };
      expect(createShareBodySchema.safeParse(body).success).toBe(false);
    });
  });

  describe("listSharesQuerySchema", () => {
    it("rejects a createdByUserId filter that is not a UUID", () => {
      const query = { "filter[createdByUserId]": "abc" };
      expect(listSharesQuerySchema.safeParse(query).success).toBe(false);
    });
  });
});
