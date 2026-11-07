import type { EffectiveBranding } from "./types";

export const makeBranding = (
  overrides: Partial<EffectiveBranding> = {}
): EffectiveBranding => ({
  scope: "auth",
  appName: "Acme",
  headline: null,
  subtitle: null,
  signInLabel: null,
  notice: null,
  layout: null,
  footerLinks: null,
  colorsLight: {},
  colorsDark: {},
  logoUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
  backgroundUrl: null,
  applyToConsole: false,
  ...overrides,
});
