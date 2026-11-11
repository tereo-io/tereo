// @module-tag unit
// @module-tag files
import { describe, expect, it } from "vitest";
import {
  downloadContentType,
  normalizeContentType,
} from "../../utils/contentType.js";

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

describe("downloadContentType", () => {
  it.each([
    "text/javascript",
    "application/javascript",
    "application/ecmascript",
    "text/ecmascript",
    "application/x-javascript",
    "application/x-ecmascript",
    "text/x-javascript",
    "text/x-ecmascript",
    "text/jscript",
    "text/livescript",
    "text/javascript1.0",
    "text/javascript1.5",
    "text/javascript; charset=utf-8",
    "Text/JavaScript",
    " application/javascript ;charset=latin1",
    // Stored before types were normalized.
    "image/png, text/javascript",
    "text/javascript;goal=module",
  ])("serves %s as plain text", (stored) => {
    expect(downloadContentType(stored)).toBe("text/plain; charset=utf-8");
  });

  it.each([
    "text/plain",
    "text/html",
    "application/json",
    "application/octet-stream",
    "image/png",
    "text/css; charset=utf-8",
    "application/javascript-archive",
    "text/typescript",
  ])("serves %s as stored", (stored) => {
    expect(downloadContentType(stored)).toBe(stored);
  });
});
