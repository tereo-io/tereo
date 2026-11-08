import { useEffect, useRef, useState, type ReactNode } from "react";
import { BRANDING_COLOR_TOKENS } from "./colorTokens";
import type { EffectiveBranding } from "./types";
import { isSafeColorValue } from "./colorValue";
import { BrandingContext } from "./useBranding";
import { usePublicAxios } from "@/lib/auth";
import { brandingImageUrl } from "./urls";
import "./styles.css";
import {
  BRANDING_STYLE_ID,
  normalizeBranding,
  readInjectedBranding,
} from "./readInjected";

const FETCH_TIMEOUT_MS = 1500;

const declarations = (colors: Record<string, string>) =>
  Object.entries(colors)
    .filter(
      ([name, value]) =>
        BRANDING_COLOR_TOKENS.includes(name) &&
        typeof value === "string" &&
        isSafeColorValue(value)
    )
    .map(([name, value]) => `${name}:${value};`)
    .join("");

/**
 * Core injects this style itself; on the fetched path the page adds it. Light
 * stays off dark pages: a bare `:root` rule would come after kosmeo's
 * `[data-theme="dark"]` one at the same specificity and win.
 */
const applyColors = (branding: EffectiveBranding) => {
  const light = declarations(branding.colorsLight);
  const dark = declarations(branding.colorsDark);
  if (!light && !dark) return;
  let style = document.getElementById(BRANDING_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = BRANDING_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent =
    (light ? `:root:not([data-theme="dark"]){${light}}` : "") +
    (dark ? `[data-theme="dark"]{${dark}}` : "");
};

/**
 * Core also rewrites the tab title and favicon when it injects branding; the
 * fetched path does the same. Returns a function that puts the page back.
 */
const applyChrome = (branding: EffectiveBranding): (() => void) => {
  const undo: (() => void)[] = [];
  if (branding.appName) {
    const previous = document.title;
    document.title = branding.appName;
    undo.push(() => {
      document.title = previous;
    });
  }
  const favicon =
    branding.scope === "auth" ? brandingImageUrl(branding.faviconUrl) : null;
  if (favicon) {
    const stock = Array.from(
      document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')
    );
    stock.forEach((l) => l.remove());
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = favicon;
    document.head.appendChild(link);
    undo.push(() => {
      link.remove();
      stock.forEach((l) => document.head.appendChild(l));
    });
  }
  return () => undo.forEach((fn) => fn());
};

interface Props {
  children: ReactNode;
  /** The preview supplies its own branding instead of reading the page's. */
  override?: EffectiveBranding | null;
}

type State =
  | { status: "pending" }
  | { status: "ready"; branding: EffectiveBranding | null };

export const BrandingProvider = ({ children, override }: Props) => {
  const axios = usePublicAxios("auth");
  const [state, setState] = useState<State>(() => {
    if (override !== undefined) return { status: "ready", branding: override };
    const injected = readInjectedBranding();
    return injected === undefined
      ? { status: "pending" }
      : { status: "ready", branding: injected };
  });

  const restoreChrome = useRef<(() => void) | null>(null);
  useEffect(() => () => restoreChrome.current?.(), []);

  useEffect(() => {
    if (state.status !== "pending") return;
    let settled = false;
    const finish = (branding: EffectiveBranding | null) => {
      if (settled) return;
      settled = true;
      try {
        if (branding) applyColors(branding);
      } catch {
        // Colours are cosmetic; the page must render regardless.
      }
      try {
        if (branding) restoreChrome.current = applyChrome(branding);
      } catch {
        // Title and icon are cosmetic too.
      }
      setState({ status: "ready", branding });
    };
    const clientId = new URLSearchParams(window.location.search).get(
      "client_id"
    );
    const timer = setTimeout(() => finish(null), FETCH_TIMEOUT_MS);
    axios
      .get<EffectiveBranding | null>("/oauth/branding", {
        params: clientId ? { client_id: clientId } : undefined,
        timeout: FETCH_TIMEOUT_MS,
      })
      .then((res) => finish(normalizeBranding(res.data) ?? null))
      .catch(() => finish(null))
      .finally(() => clearTimeout(timer));
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, []);

  if (state.status === "pending") return <div className="t-brand-loading" />;

  return (
    <BrandingContext.Provider
      value={override !== undefined ? override : state.branding}
    >
      {children}
    </BrandingContext.Provider>
  );
};
