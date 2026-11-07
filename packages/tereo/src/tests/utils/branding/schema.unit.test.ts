// @module-tag unit
// @module-tag auth
import { describe, expect, it } from "vitest";
import {
  AdminProfileBodySchema,
  ProvisionedProfileSchema,
} from "../../../utils/branding/schema.js";

const link = (url: string) => ({ label: "Terms", url });

describe("AdminProfileBodySchema", () => {
  it("accepts an empty body and normalises it", () => {
    const parsed = AdminProfileBodySchema.parse({});
    expect(parsed).toMatchObject({
      appName: null,
      headline: null,
      subtitle: null,
      signInLabel: null,
      notice: null,
      layout: null,
      footerLinks: null,
      colorsLight: {},
      colorsDark: {},
      applyToConsole: false,
      logo: null,
      logoDark: null,
      favicon: null,
      background: null,
    });
  });

  it.each([
    ["appName of 61 chars", { appName: "a".repeat(61) }],
    ["notice of 281 chars", { notice: "a".repeat(281) }],
    ["4 footer links", { footerLinks: Array(4).fill(link("https://a.test")) }],
    ["http link", { footerLinks: [link("http://a.test")] }],
    ["javascript link", { footerLinks: [link("javascript:alert(1)")] }],
    ["layout grid", { layout: "grid" }],
    ["unknown key", { customCss: "body{}" }],
    ["short sha256", { logo: { sha256: "abc" } }],
  ])("rejects %s", (_name, body) =>
    expect(AdminProfileBodySchema.safeParse(body).success).toBe(false)
  );

  it.each([
    ["a full sha256", { logo: { sha256: "a".repeat(64) } }],
    ["appName of 60 chars", { appName: "a".repeat(60) }],
    ["3 https links", { footerLinks: Array(3).fill(link("https://a.test")) }],
    ["layout split", { layout: "split" }],
  ])("accepts %s", (_name, body) =>
    expect(AdminProfileBodySchema.safeParse(body).success).toBe(true)
  );
});

describe("ProvisionedProfileSchema", () => {
  it("accepts a logo path", () =>
    expect(
      ProvisionedProfileSchema.safeParse({ logo: "./branding/logo.svg" })
        .success
    ).toBe(true));
});
