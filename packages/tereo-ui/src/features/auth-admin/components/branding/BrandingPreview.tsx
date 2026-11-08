import { PREVIEW_PAGES, PreviewBody, type PreviewPage } from "./previewPages";
import type { CSSProperties } from "react";
import { Button } from "@kosmeo-ui/react";
import { useState } from "react";
import type {
  BrandingDraft,
  BrandingImageSlot,
  BrandingLayout,
} from "../../api/branding/types";
import {
  BRANDING_COLOR_TOKENS,
  BrandingProvider,
  STOCK_COLORS,
  type EffectiveBranding,
} from "@/features/auth";

interface Props {
  draft: BrandingDraft;
  /** What the profile inherits without its own layer; null is stock Tereo. */
  inherited: EffectiveBranding | null;
}

const STOCK: EffectiveBranding = {
  scope: "auth",
  appName: null,
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
};

const IMAGE_URL_KEY = {
  logo: "logoUrl",
  logoDark: "logoDarkUrl",
  favicon: "faviconUrl",
  background: "backgroundUrl",
} as const;

const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/**
 * Draft over inherited: a non-empty draft value wins, and footer links unless
 * null; colours merge key by key.
 */
export const mergeDraft = (
  draft: BrandingDraft,
  base: EffectiveBranding | null
): EffectiveBranding => {
  const inherited = base ?? STOCK;
  const url = (slot: BrandingImageSlot) =>
    draft[slot]?.url ?? inherited[IMAGE_URL_KEY[slot]];
  return {
    scope: "auth",
    appName: blank(draft.appName) ?? inherited.appName,
    headline: blank(draft.headline) ?? inherited.headline,
    subtitle: blank(draft.subtitle) ?? inherited.subtitle,
    signInLabel: blank(draft.signInLabel) ?? inherited.signInLabel,
    notice: blank(draft.notice) ?? inherited.notice,
    layout: draft.layout ?? inherited.layout,
    // null inherits; [] is "no links", as on the server.
    footerLinks: draft.footerLinks
      ? draft.footerLinks.filter((l) => l.label.trim() && l.url.trim())
      : inherited.footerLinks,
    colorsLight: { ...inherited.colorsLight, ...draft.colorsLight },
    colorsDark: { ...inherited.colorsDark, ...draft.colorsDark },
    logoUrl: url("logo"),
    logoDarkUrl: url("logoDark"),
    faviconUrl: url("favicon"),
    backgroundUrl: url("background"),
    applyToConsole: draft.applyToConsole,
  };
};

const colorStyle = (colors: Record<string, string>): CSSProperties =>
  Object.fromEntries(
    Object.entries(colors).filter(([name]) =>
      BRANDING_COLOR_TOKENS.includes(name)
    )
  ) as CSSProperties;

/**
 * The real sign-in shell fed the unsaved draft. The colours live on the frame
 * only, so the console's own palette is untouched.
 */
export const BrandingPreview = ({ draft, inherited }: Props) => {
  const [page, setPage] = useState<PreviewPage>("login");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [layoutChoice, setLayoutChoice] = useState<BrandingLayout | null>(null);
  const merged = mergeDraft(draft, inherited);

  // A layout picked here is a look only; once the draft's layout changes, the
  // preview follows the draft again, so it shows what Save stores.
  const [seenLayout, setSeenLayout] = useState(merged.layout);
  if (seenLayout !== merged.layout) {
    setSeenLayout(merged.layout);
    setLayoutChoice(null);
  }
  const layout = layoutChoice ?? merged.layout ?? "centered";
  const branding: EffectiveBranding = { ...merged, layout };

  return (
    <div className="t-branding-preview" data-testid="branding-preview">
      <div className="t-branding-preview-controls">
        <div role="group" aria-label="Preview page">
          {PREVIEW_PAGES.map((p) => (
            <Button
              key={p.value}
              size="sm"
              variant={page === p.value ? "primary" : "secondary"}
              aria-pressed={page === p.value}
              onClick={() => setPage(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div role="group" aria-label="Preview theme">
          {(["light", "dark"] as const).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={theme === t ? "primary" : "secondary"}
              aria-pressed={theme === t}
              onClick={() => setTheme(t)}
            >
              {t === "light" ? "Light" : "Dark"}
            </Button>
          ))}
        </div>
        <div role="group" aria-label="Preview layout">
          {(["centered", "split"] as const).map((l) => (
            <Button
              key={l}
              size="sm"
              variant={layout === l ? "primary" : "secondary"}
              aria-pressed={layout === l}
              onClick={() => setLayoutChoice(l)}
            >
              {l === "centered" ? "Centered" : "Split"}
            </Button>
          ))}
        </div>
      </div>
      {/* inert: static pages must not take focus or submit. */}
      <div
        className="t-branding-preview-frame"
        data-testid="branding-preview-frame"
        data-theme={theme}
        style={colorStyle({
          ...STOCK_COLORS[theme],
          ...(theme === "dark" ? branding.colorsDark : branding.colorsLight),
        })}
        inert
      >
        <BrandingProvider override={branding}>
          <PreviewBody page={page} text={branding} />
        </BrandingProvider>
      </div>
    </div>
  );
};
