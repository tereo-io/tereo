// @module-tag unit
// @module-tag files
import { isInlineSafeContentType } from "../../../../../../../routes/v1/files/buckets/bucket/objects/utils.js";
import { describe, expect, it } from "vitest";

describe("isInlineSafeContentType", () => {
  it("never inlines a list of types, whatever comes first", () => {
    expect(isInlineSafeContentType("image/png, text/html")).toBe(false);
    expect(isInlineSafeContentType("image/png")).toBe(true);
    expect(isInlineSafeContentType("text/plain; charset=utf-8")).toBe(true);
    expect(isInlineSafeContentType("image/svg+xml")).toBe(false);
  });
});
