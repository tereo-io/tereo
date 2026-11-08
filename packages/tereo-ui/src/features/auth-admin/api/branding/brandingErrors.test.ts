import { isHttpsUrl } from "./brandingErrors";
import { describe, expect, it } from "vitest";

describe("isHttpsUrl", () => {
  it.each(["https://example.com", "HTTPS://Example.com/p?q=1"])(
    "accepts %s",
    (url) => expect(isHttpsUrl(url)).toBe(true)
  );

  it.each([
    "https:example.com",
    "https:/a.test",
    "http://example.com",
    "https://exa mple.com",
    "https://example.com/\tx",
    "https://example.com/\nx",
    " https://example.com",
    "https://",
    `https://a.test/${"a".repeat(2048)}`,
  ])("rejects %j", (url) => expect(isHttpsUrl(url)).toBe(false));
});
