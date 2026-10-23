// @module-tag unit
// @module-tag files
import { objectParamsSchema } from "../../../../../../../../routes/v1/files/buckets/bucket/objects/object/schemas.js";
import { describe, expect, it } from "vitest";

describe("PUT /v1/files/buckets/:name/objects/*objectKey", () => {
  describe("objectParamsSchema", () => {
    const parse = (objectKey: string) =>
      objectParamsSchema.safeParse({ name: "a-bucket", objectKey });

    it.each([
      ["with path traversal (..)", "test..file.txt"],
      ["starting with /", "/absolute-path.txt"],
      ["ending with /", "folder/"],
      ["with consecutive slashes", "folder//file.txt"],
      ["with invalid characters", 'file<>:"|'],
      ["exceeding 1024 characters", "a".repeat(1025) + ".txt"],
    ])("rejects an object key %s", (_label, objectKey) => {
      expect(parse(objectKey).success).toBe(false);
    });

    it.each([
      ["with slashes (folder structure)", "folder/subfolder/file.txt"],
      ["with valid special characters", "file_name-123.test.txt"],
    ])("accepts an object key %s", (_label, objectKey) => {
      expect(parse(objectKey).success).toBe(true);
    });
  });
});
