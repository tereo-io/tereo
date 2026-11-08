import { BrandingColorsSchema } from "./colors.js";
import { z } from "zod";

export const BRANDING_IMAGE_SLOTS = [
  "logo",
  "logoDark",
  "favicon",
  "background",
] as const;
export type BrandingImageSlot = (typeof BRANDING_IMAGE_SLOTS)[number];

const text = (max: number) =>
  z.string().trim().min(1).max(max).nullable().default(null);

// Exactly what the sign-in page renders: `https://` as written, and no space
// or control character, which the URL parser would trim or drop and the page
// refuses. One string, so the provisioning JSON Schema keeps the same rule.
const HTTPS_URL_PATTERN = String.raw`^[Hh][Tt][Tt][Pp][Ss]://[^\u0000-\u0020\u007f]+$`;

const httpsUrl = z
  .string()
  .max(2048)
  .regex(new RegExp(HTTPS_URL_PATTERN), {
    message: "must be an https:// URL",
    abort: true,
  })
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https:// URL")
  .meta({ pattern: HTTPS_URL_PATTERN });

const FooterLinkSchema = z
  .object({ label: z.string().trim().min(1).max(40), url: httpsUrl })
  .strict();

export const BrandingFieldsSchema = z
  .object({
    appName: text(60),
    headline: text(80),
    subtitle: text(160),
    signInLabel: text(30),
    notice: text(280),
    layout: z.enum(["centered", "split"]).nullable().default(null),
    footerLinks: z.array(FooterLinkSchema).max(3).nullable().default(null),
    colorsLight: BrandingColorsSchema.default({}),
    colorsDark: BrandingColorsSchema.default({}),
    applyToConsole: z.boolean().default(false),
  })
  .strict();
export type BrandingFields = z.output<typeof BrandingFieldsSchema>;

const ImageRefSchema = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict()
  .nullable()
  .default(null);

export const AdminProfileBodySchema = BrandingFieldsSchema.extend({
  logo: ImageRefSchema,
  logoDark: ImageRefSchema,
  favicon: ImageRefSchema,
  background: ImageRefSchema,
});

const imagePath = z.string().min(1).max(512).optional();

export const ProvisionedProfileSchema = BrandingFieldsSchema.extend({
  logo: imagePath,
  logoDark: imagePath,
  favicon: imagePath,
  background: imagePath,
});
