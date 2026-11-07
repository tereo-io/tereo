import { PREVIEW_PAGES, PreviewBody, type PreviewPage } from "./previewPages";
import { BrandingProvider, type EffectiveBranding } from "@/features/auth";
import { BRANDING_COLOR_TOKENS } from "@/features/auth";
import type { CSSProperties } from "react";
import { Button } from "@kosmeo-ui/react";
import { useState } from "react";
import type {
  BrandingDraft,
  BrandingProfile,
  BrandingImageSlot,
  BrandingLayout,
} from "../../api/branding/types";

interface Props {
  draft: BrandingDraft;
  /** Values the profile would inherit, with nothing of its own left in them. */
  inherited: EffectiveBranding;
  /** Image URLs by slot, taking precedence over the draft's (e.g. fresh uploads). */
  imageUrls?: Partial<Record<BrandingImageSlot, string | null>>;
}

const IMAGE_URL_KEY = {
  logo: "logoUrl",
  logoDark: "logoDarkUrl",
  favicon: "faviconUrl",
  background: "backgroundUrl",
} as const;

const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/** Draft over inherited: a non-empty draft value wins; colours merge key by key. */
export const mergeDraft = (
  draft: BrandingDraft,
  inherited: EffectiveBranding,
  imageUrls: Props["imageUrls"] = {}
): EffectiveBranding => {
  const url = (slot: BrandingImageSlot) =>
    imageUrls[slot] ?? draft[slot]?.url ?? inherited[IMAGE_URL_KEY[slot]];
  return {
    scope: "auth",
    appName: blank(draft.appName) ?? inherited.appName,
    headline: blank(draft.headline) ?? inherited.headline,
    subtitle: blank(draft.subtitle) ?? inherited.subtitle,
    signInLabel: blank(draft.signInLabel) ?? inherited.signInLabel,
    notice: blank(draft.notice) ?? inherited.notice,
    layout: draft.layout ?? inherited.layout,
    footerLinks: draft.footerLinks?.length
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

const without = (all: Record<string, string>, own: Record<string, string>) =>
  Object.fromEntries(Object.entries(all).filter(([k]) => !(k in own)));

/** What the profile would fall back to if it set nothing: effective minus its own values. */
export const inheritedFrom = (profile: BrandingProfile): EffectiveBranding => {
  const { effective, own } = profile;
  if (!own) return effective;
  const keep = <T,>(mine: unknown, value: T): T | null =>
    mine == null || (Array.isArray(mine) && mine.length === 0) ? value : null;
  return {
    ...effective,
    appName: keep(own.appName, effective.appName),
    headline: keep(own.headline, effective.headline),
    subtitle: keep(own.subtitle, effective.subtitle),
    signInLabel: keep(own.signInLabel, effective.signInLabel),
    notice: keep(own.notice, effective.notice),
    layout: keep(own.layout, effective.layout),
    footerLinks: keep(own.footerLinks, effective.footerLinks),
    colorsLight: without(effective.colorsLight, own.colorsLight),
    colorsDark: without(effective.colorsDark, own.colorsDark),
    logoUrl: keep(own.logo, effective.logoUrl),
    logoDarkUrl: keep(own.logoDark, effective.logoDarkUrl),
    faviconUrl: keep(own.favicon, effective.faviconUrl),
    backgroundUrl: keep(own.background, effective.backgroundUrl),
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
export const BrandingPreview = ({ draft, inherited, imageUrls }: Props) => {
  const [page, setPage] = useState<PreviewPage>("login");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [layoutChoice, setLayoutChoice] = useState<BrandingLayout | null>(null);

  const merged = mergeDraft(draft, inherited, imageUrls);
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
        data-theme={theme === "dark" ? "dark" : undefined}
        style={colorStyle(
          theme === "dark" ? branding.colorsDark : branding.colorsLight
        )}
        inert
      >
        <BrandingProvider override={branding}>
          <PreviewBody page={page} text={branding} />
        </BrandingProvider>
      </div>
    </div>
  );
};
