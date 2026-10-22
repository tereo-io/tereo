// @module-tag int
// @module-tag files
import { contentDisposition } from "../../../../../../../routes/v1/files/buckets/bucket/objects/utils.js";
import { describe, expect, it } from "vitest";

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
