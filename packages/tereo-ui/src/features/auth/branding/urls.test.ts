import { brandingImageUrl, isSafeUrl } from "./urls";
import { describe, expect, it } from "vitest";
import env from "@/lib/env";

describe("isSafeUrl", () => {
  it.each([
    "https://acme.test/privacy",
    "/oauth/branding/assets/a.png",
    `${new URL(env.CORE_URL).origin}/x`,
  ])("accepts %s", (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  it.each([
    "//evil.test",
    "/\\evil.test",
    "/\t/evil.test",
    "/\n/evil.test",
    "/\r/evil.test",
    "https://acme.test/\tx",
    "javascript:alert(1)",
    "data:text/html,x",
    "http://evil.test/",
    "",
  ])("rejects %j", (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });
});

describe("brandingImageUrl", () => {
  it("resolves a root-relative path against core", () => {
    expect(brandingImageUrl("/oauth/branding/assets/a.png")).toBe(
      `${new URL(env.CORE_URL).origin}/oauth/branding/assets/a.png`
    );
  });

  it("loads the page's own origin", () => {
    const url = `${window.location.origin}/logo.png`;
    expect(brandingImageUrl(url)).toBe(url);
  });

  it("refuses another origin, even over https", () => {
    expect(brandingImageUrl("https://evil.test/a.png")).toBeNull();
    expect(brandingImageUrl("/\t/evil.test/a.png")).toBeNull();
  });
});
