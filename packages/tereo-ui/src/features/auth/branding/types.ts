export interface BrandingFooterLink {
  label: string;
  url: string;
}

/** What core resolves for a client; `scope` says how much of it applies. */
export interface EffectiveBranding {
  scope: "auth" | "console";
  appName: string | null;
  headline: string | null;
  subtitle: string | null;
  signInLabel: string | null;
  notice: string | null;
  layout: "centered" | "split" | null;
  footerLinks: BrandingFooterLink[] | null;
  colorsLight: Record<string, string>;
  colorsDark: Record<string, string>;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  backgroundUrl: string | null;
  applyToConsole: boolean;
}
