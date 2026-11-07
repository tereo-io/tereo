import type { BrandingFooterLink, EffectiveBranding } from "@/features/auth";

export type BrandingSource = "client" | "default" | "tereo";
export type BrandingLayout = "centered" | "split";

export const BRANDING_IMAGE_SLOTS = [
  "logo",
  "logoDark",
  "favicon",
  "background",
] as const;
export type BrandingImageSlot = (typeof BRANDING_IMAGE_SLOTS)[number];

export const BRANDING_TEXT_SLOTS = [
  "appName",
  "headline",
  "subtitle",
  "signInLabel",
  "notice",
] as const;
export type BrandingTextSlot = (typeof BRANDING_TEXT_SLOTS)[number];

export interface BrandingImage {
  sha256: string;
  url: string;
}

export interface BrandingValues {
  appName: string | null;
  headline: string | null;
  subtitle: string | null;
  signInLabel: string | null;
  notice: string | null;
  layout: BrandingLayout | null;
  footerLinks: BrandingFooterLink[] | null;
  colorsLight: Record<string, string>;
  colorsDark: Record<string, string>;
  applyToConsole: boolean;
}

/** A profile's own values, as core returns them. */
export type BrandingOwn = BrandingValues &
  Record<BrandingImageSlot, BrandingImage | null>;

/** What the editor holds while the admin works; the same shape as `own`. */
export type BrandingDraft = BrandingOwn;

/** The PUT body: image slots carry only the uploaded object's hash. */
export type AdminProfileBody = BrandingValues &
  Record<BrandingImageSlot, { sha256: string } | null>;

export interface BrandingProfile {
  client: { id: string; clientId: string; name: string } | null;
  /** null when the target has no profile of its own. */
  own: BrandingOwn | null;
  effective: EffectiveBranding;
  /** The merge without this profile's own layer; null means stock Tereo. */
  inherited: EffectiveBranding | null;
  /** Where each slot's effective value comes from. */
  sources: Partial<Record<string, BrandingSource>>;
  colorSources: {
    light: Record<string, BrandingSource>;
    dark: Record<string, BrandingSource>;
  };
  provisioned: boolean;
  provisionedFrom: string | null;
  updatedAt: string | null;
  canEdit: boolean;
  canManageGrants: boolean;
}

export interface BrandingListEntry {
  id: string;
  clientId: string;
  name: string;
  provisioned: boolean;
  updatedAt: string;
}

export interface BrandingList {
  default: { provisioned: boolean; updatedAt: string | null } | null;
  clients: BrandingListEntry[];
}

export type BrandingTarget =
  { kind: "default" } | { kind: "client"; id: string };

export const targetPath = (target: BrandingTarget) =>
  target.kind === "default"
    ? "/v1/admin/branding/default"
    : `/v1/admin/branding/clients/${target.id}`;

export const emptyDraft = (): BrandingDraft => ({
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
