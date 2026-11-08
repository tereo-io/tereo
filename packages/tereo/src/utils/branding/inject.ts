import { BRANDING_COLOR_TOKENS } from "../../definitions/brandingTokens.js";
import type { EffectiveBranding } from "./merge.js";
import { isSafeColorValue } from "./colors.js";

export type BrandingScope = "auth" | "console";

const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

const hex4 = (char: string) =>
  "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");

/**
 * JSON safe inside a `<script>` element: nothing in it can close the element
 * or, read as JavaScript, end a line inside a string.
 */
export function serializeForScript(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(SCRIPT_UNSAFE, hex4);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

const TOKENS = new Set(BRANDING_COLOR_TOKENS);

// Values are validated on write; this re-check keeps a row written some other
// way from closing the rule or the <style> element.
const declarations = (colors: Record<string, string>) =>
  Object.entries(colors)
    .filter(
      ([name, value]) =>
        TOKENS.has(name) && typeof value === "string" && isSafeColorValue(value)
    )
    .map(([name, value]) => `${name}:${value};`)
    .join("");

// Light is kept off the dark theme: as a bare `:root` rule it would match
// kosmeo's `[data-theme="dark"]` specificity and, coming later, win over it.
export function brandingStyle(
  light: Record<string, string>,
  dark: Record<string, string>
): string {
  const lightRule = declarations(light);
  const darkRule = declarations(dark);
  return (
    (lightRule ? `:root:not([data-theme="dark"]){${lightRule}}` : "") +
    (darkRule ? `[data-theme="dark"]{${darkRule}}` : "")
  );
}

const STOCK_ICON =
  /<link\b[^>]*\brel=["']?(?:shortcut\s+)?icon["'\s>/][^>]*>\s*/gi;

// Replacements are functions throughout: a string replacement would expand
// `$&`, `$'` and the like in user-supplied text.
const beforeHeadEnd = (html: string, tags: string) =>
  html.replace(/<\/head>/i, (end) => `${tags}${end}`);

/**
 * The app shell with branding for its first paint. `null` on the auth scope
 * still writes the JSON block, so the UI renders stock without fetching.
 */
export function injectBranding(
  html: string,
  branding: EffectiveBranding | null,
  scope: BrandingScope
): string {
  if (!branding) {
    return beforeHeadEnd(
      html,
      `<script type="application/json" id="tereo-branding">null</script>`
    );
  }

  const payload =
    scope === "console"
      ? {
          scope,
          appName: branding.appName,
          colorsLight: branding.colorsLight,
          colorsDark: branding.colorsDark,
        }
      : { scope, ...branding };

  const tags: string[] = [];
  const style = brandingStyle(branding.colorsLight, branding.colorsDark);
  if (style) tags.push(`<style id="tereo-branding-style">${style}</style>`);
  tags.push(
    `<script type="application/json" id="tereo-branding">${serializeForScript(payload)}</script>`
  );

  let out = html;
  if (scope === "auth") {
    for (const url of [branding.logoUrl, branding.backgroundUrl]) {
      if (url) {
        tags.push(`<link rel="preload" as="image" href="${escapeHtml(url)}">`);
      }
    }
    if (branding.faviconUrl) {
      out = out.replace(STOCK_ICON, "");
      tags.push(`<link rel="icon" href="${escapeHtml(branding.faviconUrl)}">`);
    }
    if (branding.layout) {
      const layout = escapeHtml(branding.layout);
      out = out.replace(
        /<html\b/i,
        (open) => `${open} data-brand-layout="${layout}"`
      );
    }
  }

  if (branding.appName) {
    const title = escapeHtml(branding.appName);
    out = out.replace(
      /<title\b[^>]*>[\s\S]*?<\/title>/i,
      () => `<title>${title}</title>`
    );
  }

  return beforeHeadEnd(out, tags.join(""));
}
