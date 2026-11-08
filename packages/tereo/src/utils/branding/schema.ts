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

const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https: URL")
  // For the provisioning JSON Schema; the refine above is what enforces it.
  .meta({ pattern: "^[Hh][Tt][Tt][Pp][Ss]:" });

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
