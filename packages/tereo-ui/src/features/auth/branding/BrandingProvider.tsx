import { BRANDING_STYLE_ID, readInjectedBranding } from "./readInjected";
import { useEffect, useState, type ReactNode } from "react";
import { BRANDING_COLOR_TOKENS } from "./colorTokens";
import type { EffectiveBranding } from "./types";
import { BrandingContext } from "./useBranding";
import { usePublicAxios } from "@/lib/auth";
import "./styles.css";

const FETCH_TIMEOUT_MS = 1500;
const SAFE_VALUE = /^[#0-9a-zA-Z.,%/ ()]+$/;

const declarations = (colors: Record<string, string>) =>
  Object.entries(colors)
    .filter(
      ([name, value]) =>
        BRANDING_COLOR_TOKENS.includes(name) && SAFE_VALUE.test(value)
    )
    .map(([name, value]) => `${name}:${value};`)
    .join("");

/** Core injects this style itself; on the fetched path the page adds it. */
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
    (light ? `:root{${light}}` : "") +
    (dark ? `[data-theme="dark"]{${dark}}` : "");
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
    return injected
      ? { status: "ready", branding: injected }
      : { status: "pending" };
  });

  useEffect(() => {
    if (state.status !== "pending") return;
    let settled = false;
    const finish = (branding: EffectiveBranding | null) => {
      if (settled) return;
      settled = true;
      if (branding) applyColors(branding);
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
      .then((res) => finish(res.data ?? null))
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
