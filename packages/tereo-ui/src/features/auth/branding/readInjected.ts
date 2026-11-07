import type { EffectiveBranding } from "./types";

export const BRANDING_ELEMENT_ID = "tereo-branding";
export const BRANDING_STYLE_ID = "tereo-branding-style";

/** `undefined` when core injected nothing, so the page must ask for it. */
export const readInjectedBranding = (
  doc: Document = document
): EffectiveBranding | undefined => {
  const el = doc.getElementById(BRANDING_ELEMENT_ID);
  if (!el) return undefined;
  try {
    return JSON.parse(el.textContent ?? "") as EffectiveBranding;
  } catch {
    return undefined;
  }
};
