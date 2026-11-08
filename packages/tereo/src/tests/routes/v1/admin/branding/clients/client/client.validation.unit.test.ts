// @module-tag unit
// @module-tag auth
import { PutBrandingProfileSchema } from "../../../../../../../routes/v1/admin/branding/clients/client/schemas.js";
import { AdminProfileBodySchema } from "../../../../../../../utils/branding/schema.js";
import { describe, expect, it } from "vitest";

const link = (label: string, url = "https://a.test") => ({ label, url });

describe("PUT /v1/admin/branding/clients/:id", () => {
  it("validates the body with AdminProfileBodySchema", () => {
    expect(PutBrandingProfileSchema).toBe(AdminProfileBodySchema);
  });

  it.each([
    ["appName", { appName: "a".repeat(61) }],
    ["headline", { headline: "a".repeat(81) }],
    ["subtitle", { subtitle: "a".repeat(161) }],
    ["signInLabel", { signInLabel: "a".repeat(31) }],
    ["notice", { notice: "a".repeat(281) }],
    ["footerLinks.0.label", { footerLinks: [link("a".repeat(41))] }],
    ["footerLinks", { footerLinks: Array(4).fill(link("Terms")) }],
    ["footerLinks.0.url", { footerLinks: [link("Terms", "http://a.test")] }],
    ["colorsLight", { colorsLight: { "--k-primary-color": "red" } }],
    ["logo.sha256", { logo: { sha256: "abc" } }],
  ])("rejects an out-of-limit %s", (path, body) => {
    const result = PutBrandingProfileSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path.join(".").startsWith(path)).toBe(true);
  });
});
