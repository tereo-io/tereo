// @module-tag unit
// @module-tag files
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  contentDisposition,
  extractTagsFromRequest,
  handleMetadata,
  isInlineSafeContentType,
} from "../../../../../../../routes/v1/files/buckets/bucket/objects/utils.js";

describe("isInlineSafeContentType", () => {
  it("never inlines a list of types, whatever comes first", () => {
    expect(isInlineSafeContentType("image/png, text/html")).toBe(false);
    expect(isInlineSafeContentType("image/png")).toBe(true);
    expect(isInlineSafeContentType("text/plain; charset=utf-8")).toBe(true);
    expect(isInlineSafeContentType("image/svg+xml")).toBe(false);
  });
});

describe("contentDisposition", () => {
  const CYRILLIC = "Отчёт.zip";
  const EMOJI = "report 📦 (final).pdf";

  const encodedName = (header: string): string =>
    decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(header)![1]);
  it("gives an ASCII fallback and the real name in filename*", () => {
    const value = contentDisposition("attachment", CYRILLIC);
    expect(value).toMatch(/^attachment; filename="_____\.zip"; filename\*=/);
    expect(encodedName(value)).toBe(CYRILLIC);
  });

  it("encodes RFC 5987 specials and keeps the value Latin-1", () => {
    const value = contentDisposition("inline", EMOJI);
    expect(value).not.toMatch(/[^\x20-\x7e]/);
    expect(value).toContain("%28final%29");
    expect(encodedName(value)).toBe(EMOJI);
  });

  it("neutralises quotes, backslashes, controls and lone surrogates", () => {
    const value = contentDisposition("attachment", 'a"b\\c\r\nd\uD800.txt');
    expect(value).toContain('filename="a_b_c__d_.txt"');
  });
});

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
    expect(thrown(() => tags(JSON.stringify(["x".repeat(129)])))).toMatchObject(
      { statusCode: 400, code: "tag_too_long" }
    );
  });
});
