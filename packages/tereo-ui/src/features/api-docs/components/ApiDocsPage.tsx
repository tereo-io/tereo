import { Centered, EmptyState, Page, Spinner } from "@kosmeo-ui/react";
import { useSpecAvailable } from "../useSpecAvailable";
import { RedocStandalone } from "redoc";
import { useTheme } from "@/lib/theme";
import { SPEC_URL } from "../specUrl";
import { useEffect } from "react";
import "./styles.css";

// Redoc derives shades from these with `polished`, so they must be literal
// colors, not CSS variables. The dark values mirror @kosmeo-ui/react's dark tokens.
const LIGHT_THEME = {
  typography: { fontFamily: "inherit" },
};

const DARK_THEME = {
  typography: { fontFamily: "inherit" },
  colors: {
    primary: { main: "#6e9fff" },
    text: { primary: "#e4e6eb", secondary: "#c8ccd4" },
    border: { dark: "#353a45", light: "#2a2f3a" },
    http: {
      get: "#4ec98a",
      post: "#7e91d8",
      put: "#f0b840",
      delete: "#ef6b78",
      options: "#c8ccd4",
      patch: "#f0b840",
      basic: "#c8ccd4",
      link: "#6e9fff",
      head: "#c8ccd4",
    },
    success: { main: "#4ec98a" },
    warning: { main: "#f0b840" },
    error: { main: "#ef6b78" },
  },
  sidebar: {
    backgroundColor: "#1a1d24",
    textColor: "#e4e6eb",
    activeTextColor: "#6e9fff",
    level1Items: {
      activeBackgroundColor: "#2a2f3a",
      activeTextColor: "#6e9fff",
      textTransform: "none",
    },
    groupItems: {
      activeBackgroundColor: "#2a2f3a",
      activeTextColor: "#6e9fff",
      textTransform: "uppercase",
    },
    arrow: {
      color: "#9aa0aa",
    },
  },
  rightPanel: {
    backgroundColor: "#0e1119",
    textColor: "#e4e6eb",
  },
  codeBlock: { backgroundColor: "#0e1119" },
  schema: {
    nestedBackground: "#1a1d24",
    typeNameColor: "#9aa0aa",
    typeTitleColor: "#e4e6eb",
  },
};

const isLightBackground = (bg: string) => {
  const m = bg.match(/[\d.]+/g);
  if (!m) return false;
  const [r, g, b, a] = m.map(Number);
  if (a === 0) return false;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.85;
};

/**
 * Some Redoc elements hard-code white backgrounds that its theme can't reach.
 * In dark mode, repaint any near-white background as it renders.
 */
const useDarkBackgroundPatch = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) return;
    const root = document.querySelector(".t-api-docs");
    if (!root) return;
    const darkBg =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--background-color")
        .trim() || "#15181f";
    const patch = () => {
      for (const el of root.querySelectorAll<HTMLElement>("div, section, tr")) {
        if (el.dataset.vqDarkPatched) continue;
        if (isLightBackground(getComputedStyle(el).backgroundColor)) {
          el.style.backgroundColor = darkBg;
          el.dataset.vqDarkPatched = "1";
        }
      }
    };
    patch();
    const observer = new MutationObserver(patch);
    observer.observe(root, { subtree: true, childList: true });
    return () => observer.disconnect();
  }, [enabled]);
};

export const ApiDocsPage = () => {
  const { resolvedTheme } = useTheme();
  const { data: available, isLoading } = useSpecAvailable(SPEC_URL);
  useDarkBackgroundPatch(resolvedTheme === "dark" && available === true);

  if (isLoading) {
    return (
      <Page fillHeight maxWidth="none">
        <Centered>
          <Spinner />
        </Centered>
      </Page>
    );
  }

  if (!available) {
    return (
      <Page padded maxWidth="narrow">
        <EmptyState layout="block">
          This build has no API spec. Generate core&apos;s bundled spec and run{" "}
          <code>npm run openapi:sync</code> in the UI package.
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page fillHeight maxWidth="none">
      <div className="t-api-docs" data-redoc-theme={resolvedTheme}>
        <RedocStandalone
          key={resolvedTheme}
          specUrl={SPEC_URL}
          options={{
            scrollYOffset: 0,
            hideDownloadButton: false,
            theme: resolvedTheme === "dark" ? DARK_THEME : LIGHT_THEME,
          }}
        />
      </div>
    </Page>
  );
};
