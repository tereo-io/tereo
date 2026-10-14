import { describe, expect, it } from "vitest";
import { checkPublicUrl } from "../../env.js";

describe("checkPublicUrl", () => {
  it("requires PUBLIC_URL in production", () => {
    expect(checkPublicUrl(undefined, "production")).toMatch(/required/);
  });

  it.each([
    "http://localhost:4001",
    "http://127.0.0.1:4001",
    "http://[::1]:4001",
  ])("refuses %s in production", (url) => {
    expect(checkPublicUrl(url, "production")).toMatch(/not localhost/);
  });

  it("refuses plain http in production", () => {
    expect(checkPublicUrl("http://core.example.com", "production")).toMatch(
      /https/
    );
  });

  it("accepts a public URL in production", () => {
    expect(
      checkPublicUrl("https://core.example.com", "production")
    ).toBeUndefined();
  });

  it("allows it unset or local outside production", () => {
    expect(checkPublicUrl(undefined, "development")).toBeUndefined();
    expect(checkPublicUrl("http://localhost:4001", "test")).toBeUndefined();
  });
});
