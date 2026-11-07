import { BRANDING_COLOR_TOKENS } from "@/features/auth";
import type { BrandingDraft } from "./types";
import { AxiosError } from "axios";

export const TEXT_LIMITS = {
  appName: 60,
  headline: 80,
  subtitle: 160,
  signInLabel: 30,
  notice: 280,
} as const;
export const FOOTER_LABEL_MAX = 40;
export const FOOTER_LINKS_MAX = 3;
export const FOOTER_URL_MAX = 2048;
export const COLOR_VALUE_MAX = 64;

// Copies of core's isSafeColorValue grammar (utils/branding/colors.ts); core stays authoritative.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL = /^(?:rgba?|hsla?|oklch)\(([0-9.%deg ,/]+)\)$/;

export const isSafeColorValue = (value: string): boolean => {
  if (value.length > COLOR_VALUE_MAX) return false;
  if (HEX.test(value)) return true;
  const m = FUNCTIONAL.exec(value);
  return !!m && /[0-9]/.test(m[1]);
};

export const isHttpsUrl = (value: string): boolean => {
  if (value.length > FOOTER_URL_MAX) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** Field-path keyed messages, e.g. `colorsLight.--k-primary-color`, `footerLinks.0.url`. */
export const validateDraft = (draft: BrandingDraft): Record<string, string> => {
  const errors: Record<string, string> = {};
  for (const [slot, max] of Object.entries(TEXT_LIMITS)) {
    const v = draft[slot as keyof typeof TEXT_LIMITS];
    if (v != null && v.trim().length > max)
      errors[slot] = `At most ${max} characters`;
  }
  (draft.footerLinks ?? []).forEach((link, i) => {
    if (!link.label.trim()) errors[`footerLinks.${i}.label`] = "Required";
    else if (link.label.trim().length > FOOTER_LABEL_MAX)
      errors[`footerLinks.${i}.label`] =
        `At most ${FOOTER_LABEL_MAX} characters`;
    if (!isHttpsUrl(link.url.trim()))
      errors[`footerLinks.${i}.url`] = "Must be an https:// link";
  });
  if ((draft.footerLinks?.length ?? 0) > FOOTER_LINKS_MAX)
    errors.footerLinks = `At most ${FOOTER_LINKS_MAX} links`;
  for (const key of ["colorsLight", "colorsDark"] as const) {
    for (const [token, value] of Object.entries(draft[key])) {
      if (!BRANDING_COLOR_TOKENS.includes(token))
        errors[`${key}.${token}`] = "Unknown colour variable";
      else if (!isSafeColorValue(value))
        errors[`${key}.${token}`] = "Not an allowed colour value";
    }
  }
  return errors;
};

type ApiError = AxiosError<{ error_description?: string; message?: string }>;

/** The server's reason, for showing on the field or in a toast. */
export const brandingErrorMessage = (error: unknown, fallback: string) => {
  const data = (error as ApiError | undefined)?.response?.data;
  return data?.error_description || data?.message || fallback;
};
