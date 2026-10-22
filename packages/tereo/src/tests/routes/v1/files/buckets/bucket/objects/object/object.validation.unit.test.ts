// @module-tag unit
// @module-tag files
import { objectParamsSchema } from "../../../../../../../../routes/v1/files/buckets/bucket/objects/object/schemas.js";
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  extractTagsFromRequest,
  handleMetadata,
} from "../../../../../../../../routes/v1/files/buckets/bucket/objects/utils.js";

const withHeaders = (headers: Record<string, string>) =>
  ({ headers }) as unknown as Request;

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
};

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

  describe("handleMetadata", () => {
    const metadata = (header: string) =>
      handleMetadata(withHeaders({ "x-metadata": header }));

    it.each([
      ["string values", { author: "test-user", description: "test file" }],
      ["number values", { version: 1, size: 12345 }],
      ["boolean and null values", { isPublic: true, deletedAt: null }],
      ["array values", { tags: ["tag1", "tag2", "tag3"], numbers: [1, 2, 3] }],
    ])("accepts metadata with %s", (_label, value) => {
      expect(metadata(JSON.stringify(value))).toEqual(value);
    });

    it.each([
      ["a key longer than 255 characters", { ["a".repeat(256)]: "value" }],
      [
        "more than 100 keys",
        Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`key${i}`, "value"])
        ),
      ],
      [
        "a string value longer than 10000 characters",
        { description: "x".repeat(10001) },
      ],
      ["an array larger than 100 elements", { items: Array(101).fill("item") }],
    ])("rejects metadata with %s", (_label, value) => {
      expect(thrown(() => metadata(JSON.stringify(value)))).toMatchObject({
        statusCode: 400,
        code: "invalid_metadata",
      });
    });

    it("rejects invalid JSON in the metadata header", () => {
      expect(thrown(() => metadata("{invalid json}"))).toMatchObject({
        statusCode: 400,
        code: "invalid_metadata",
      });
    });
  });

  describe("extractTagsFromRequest", () => {
    const tags = (header: string) =>
      extractTagsFromRequest(withHeaders({ "x-tags": header }));

    it.each([
      ["invalid JSON", '["a", '],
      ["a comma-form value starting with [", "[draft], final"],
      ["a non-string entry", '["a", 1]'],
      ["an empty tag", '["a", ""]'],
      ["an object", '[{"a":1}]'],
    ])("refuses %s rather than reading it as commas", (_label, header) => {
      expect(thrown(() => tags(header))).toMatchObject({
        statusCode: 400,
        code: "invalid_request",
      });
    });

    it("applies the count and length limits to the JSON form", () => {
      expect(
        thrown(() =>
          tags(JSON.stringify(Array.from({ length: 51 }, (_, i) => `t${i}`)))
        )
      ).toMatchObject({ statusCode: 400, code: "too_many_tags" });
      expect(
        thrown(() => tags(JSON.stringify(["x".repeat(129)])))
      ).toMatchObject({ statusCode: 400, code: "tag_too_long" });
    });
  });
});
