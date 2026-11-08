import type { EffectiveBranding } from "./types";

export const BRANDING_ELEMENT_ID = "tereo-branding";
export const BRANDING_STYLE_ID = "tereo-branding-style";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const colorMap = (v: unknown): Record<string, string> =>
  isRecord(v) ? (v as Record<string, string>) : {};

/** `null` is a valid "no branding"; `undefined` means the payload is malformed. */
export const normalizeBranding = (
  value: unknown
): EffectiveBranding | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  return {
    ...(value as unknown as EffectiveBranding),
    colorsLight: colorMap(value.colorsLight),
    colorsDark: colorMap(value.colorsDark),
    footerLinks: Array.isArray(value.footerLinks) ? value.footerLinks : null,
  };
};

/**
 * `null` when core injected "no branding", `undefined` when the block is
 * absent or unreadable, so the page must ask for it.
 */
export const readInjectedBranding = (
  doc: Document = document
): EffectiveBranding | null | undefined => {
  const el = doc.getElementById(BRANDING_ELEMENT_ID);
  if (!el) return undefined;
  try {
    return normalizeBranding(JSON.parse(el.textContent ?? ""));
  } catch {
    return undefined;
  }
};
