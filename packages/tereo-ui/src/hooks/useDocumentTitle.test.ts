import { formatDocumentTitle, setDocumentAppName } from "./useDocumentTitle";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => setDocumentAppName(null));

describe("formatDocumentTitle", () => {
  it("suffixes Tereo by default", () => {
    expect(formatDocumentTitle("Users")).toBe("Users · Tereo");
    expect(formatDocumentTitle()).toBe("Tereo");
  });

  it("uses the console branding name once set", () => {
    setDocumentAppName("Acme Console");
    expect(formatDocumentTitle("Users")).toBe("Users · Acme Console");
    expect(formatDocumentTitle()).toBe("Acme Console");
  });
});
