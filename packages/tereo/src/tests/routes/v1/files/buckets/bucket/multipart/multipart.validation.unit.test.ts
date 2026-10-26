// @module-tag unit
// @module-tag files
import { initiateBodySchema } from "../../../../../../../routes/v1/files/buckets/bucket/multipart/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/files/buckets/:name/multipart", () => {
  describe("initiateBodySchema", () => {
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
    ])("rejects metadata with %s", (_label, metadata) => {
      const body = {
        objectKey: "meta-limits.bin",
        contentType: "application/octet-stream",
        metadata,
      };
      expect(initiateBodySchema.safeParse(body).success).toBe(false);
    });
  });
});
