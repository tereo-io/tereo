import { isInlineSafeContentType } from "../../routes/v1/files/buckets/bucket/objects/utils.js";
import { normalizeContentType } from "../../utils/contentType.js";
import { describe, expect, it } from "vitest";

describe("normalizeContentType", () => {
  it("keeps a single type, lowercased, with at most a charset", () => {
    expect(normalizeContentType("image/PNG")).toBe("image/png");
    expect(normalizeContentType(" Text/Plain ; Charset=UTF-8 ")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(normalizeContentType("application/vnd.api+json")).toBe(
      "application/vnd.api+json"
    );
  });

  it("refuses lists, other parameters and junk", () => {
    for (const raw of [
      "image/png, text/html",
      "image/png,text/html",
      "text/plain; boundary=x",
      "text/plain; charset=utf-8; charset=latin1",
      'text/plain; charset="utf-8"',
      "text/html\r\nX-Injected: 1",
      "image",
      "",
      "/png",
    ]) {
      expect(normalizeContentType(raw), raw).toBeNull();
    }
  });
});

describe("isInlineSafeContentType", () => {
  it("never inlines a list of types, whatever comes first", () => {
    expect(isInlineSafeContentType("image/png, text/html")).toBe(false);
    expect(isInlineSafeContentType("image/png")).toBe(true);
    expect(isInlineSafeContentType("text/plain; charset=utf-8")).toBe(true);
    expect(isInlineSafeContentType("image/svg+xml")).toBe(false);
  });
});
