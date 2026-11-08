// @module-tag unit
// @module-tag platform
// @module-tag security
import type { EffectiveBranding } from "../../../utils/branding/merge.js";
import { describe, expect, it } from "vitest";
import {
  brandingStyle,
  injectBranding,
  serializeForScript,
} from "../../../utils/branding/inject.js";

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <title>Tereo</title>
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  </head>
  <body><div id="root"></div></body>
</html>`;

const branding = (
  over: Partial<EffectiveBranding> = {}
): EffectiveBranding => ({
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
  ...over,
});

const jsonBlock = (html: string) => {
  const match =
    /<script type="application\/json" id="tereo-branding">([\s\S]*?)<\/script>/.exec(
      html
    );
  expect(match, "no #tereo-branding block").not.toBeNull();
  return match![1];
};

const head = (html: string) => html.slice(0, html.indexOf("</head>"));

describe("serializeForScript", () => {
  it("escapes <, >, &, U+2028 and U+2029 as backslash-u sequences", () => {
    const out = serializeForScript({ a: "<>&\u2028\u2029" });
    expect(out).toBe('{"a":"\\u003c\\u003e\\u0026\\u2028\\u2029"}');
    expect(JSON.parse(out)).toEqual({ a: "<>&\u2028\u2029" });
  });

  it("serializes null and undefined as null", () => {
    expect(serializeForScript(null)).toBe("null");
    expect(serializeForScript(undefined)).toBe("null");
  });
});

describe("brandingStyle", () => {
  // Kosmeo's dark values sit under [data-theme="dark"], as specific as :root;
  // a bare :root rule later in the document would win over them.
  it("scopes light away from the dark theme and writes dark under [data-theme=dark]", () => {
    expect(
      brandingStyle(
        { "--k-primary-color": "#00bb55" },
        { "--k-primary-color": "rgb(1, 2, 3)" }
      )
    ).toBe(
      ':root:not([data-theme="dark"]){--k-primary-color:#00bb55;}[data-theme="dark"]{--k-primary-color:rgb(1, 2, 3);}'
    );
  });

  it("produces no rule for an empty map", () => {
    expect(brandingStyle({}, {})).toBe("");
    expect(brandingStyle({ "--k-primary-color": "#fff" }, {})).toBe(
      ':root:not([data-theme="dark"]){--k-primary-color:#fff;}'
    );
  });

  it("drops names and values outside the allowed grammar", () => {
    expect(
      brandingStyle(
        {
          "--k-primary-color": "red;}</style><script>alert(1)</script>",
          "--not-a-token": "#fff",
          "--k-primary-color-hover": "#abc",
        },
        { "--k-primary-color": "url(x)" }
      )
    ).toBe(':root:not([data-theme="dark"]){--k-primary-color-hover:#abc;}');
  });
});

describe("injectBranding", () => {
  it("keeps a closing script tag in the headline from ending the JSON block", () => {
    const headline = "</script><script>alert(1)</script>";
    const html = injectBranding(SHELL, branding({ headline }), "auth");
    const block = jsonBlock(html);
    expect(block).not.toContain("</script");
    expect(block).not.toContain("<");
    const parsed = JSON.parse(block);
    expect(parsed.headline).toBe(headline);
    expect(parsed.scope).toBe("auth");
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("escapes U+2028 and U+2029 in the JSON block", () => {
    const html = injectBranding(
      SHELL,
      branding({ notice: "a\u2028b\u2029c" }),
      "auth"
    );
    const block = jsonBlock(html);
    expect(block).not.toMatch(/[\u2028\u2029]/);
    expect(block).toContain("\\u2028");
    expect(JSON.parse(block).notice).toBe("a\u2028b\u2029c");
  });

  it("writes the app name into <title> as escaped text", () => {
    const html = injectBranding(SHELL, branding({ appName: "<b>" }), "auth");
    expect(html).toContain("<title>&lt;b&gt;</title>");
    expect(html).not.toContain("<title>Tereo</title>");
  });

  it("does not expand $ patterns in the app name", () => {
    const html = injectBranding(
      SHELL,
      branding({ appName: "$' $& $`" }),
      "auth"
    );
    expect(html).toContain("<title>$&#39; $&amp; $`</title>");
  });

  it("keeps the stock title when there is no app name", () => {
    expect(injectBranding(SHELL, branding(), "auth")).toContain(
      "<title>Tereo</title>"
    );
  });

  it("adds preloads, the favicon and the layout for the auth scope", () => {
    const html = injectBranding(
      SHELL,
      branding({
        logoUrl: "/oauth/branding/assets/a.png",
        backgroundUrl: "/oauth/branding/assets/b.jpg",
        faviconUrl: "/oauth/branding/assets/c.svg",
        layout: "split",
      }),
      "auth"
    );
    expect(head(html)).toContain(
      '<link rel="preload" as="image" href="/oauth/branding/assets/a.png">'
    );
    expect(head(html)).toContain(
      '<link rel="preload" as="image" href="/oauth/branding/assets/b.jpg">'
    );
    expect(head(html)).toContain(
      '<link rel="icon" href="/oauth/branding/assets/c.svg">'
    );
    expect(html).not.toContain("/favicon.ico");
    expect(html).not.toContain("/favicon.svg");
    expect(html).toContain("apple-touch-icon");
    expect(html).toContain('<html data-brand-layout="split" lang="en">');
  });

  it("keeps the stock favicons when there is no favicon", () => {
    const html = injectBranding(SHELL, branding(), "auth");
    expect(html).toContain('href="/favicon.ico"');
    expect(html).not.toContain("data-brand-layout");
  });

  it("puts the style and JSON blocks in <head>", () => {
    const html = injectBranding(
      SHELL,
      branding({ colorsLight: { "--k-primary-color": "#00bb55" } }),
      "auth"
    );
    expect(head(html)).toContain(
      '<style id="tereo-branding-style">:root:not([data-theme="dark"]){--k-primary-color:#00bb55;}</style>'
    );
    expect(head(html)).toContain('id="tereo-branding"');
  });

  it("writes no <style> when both colour maps are empty", () => {
    const html = injectBranding(SHELL, branding({ appName: "Acme" }), "auth");
    expect(html).not.toContain("<style");
    expect(html).toContain('id="tereo-branding"');
  });

  it("keeps only colours and the app name for the console scope", () => {
    const html = injectBranding(
      SHELL,
      branding({
        appName: "Acme",
        headline: "Welcome",
        logoUrl: "/oauth/branding/assets/a.png",
        backgroundUrl: "/oauth/branding/assets/b.jpg",
        faviconUrl: "/oauth/branding/assets/c.svg",
        layout: "split",
        colorsLight: { "--k-primary-color": "#445566" },
        colorsDark: { "--k-primary-color": "#112233" },
        applyToConsole: true,
      }),
      "console"
    );
    expect(JSON.parse(jsonBlock(html))).toEqual({
      scope: "console",
      appName: "Acme",
      colorsLight: { "--k-primary-color": "#445566" },
      colorsDark: { "--k-primary-color": "#112233" },
    });
    expect(html).not.toContain('rel="preload"');
    expect(html).not.toContain("/oauth/branding/assets/");
    expect(html).not.toContain("data-brand-layout");
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain("<title>Acme</title>");
    expect(html).toContain(
      ':root:not([data-theme="dark"]){--k-primary-color:#445566;}'
    );
    expect(html).toContain('[data-theme="dark"]{--k-primary-color:#112233;}');
  });

  it("writes a null block and nothing else when no branding resolves", () => {
    const html = injectBranding(SHELL, null, "auth");
    expect(jsonBlock(html)).toBe("null");
    expect(html).not.toContain("<style");
    expect(html).not.toContain('rel="preload"');
    expect(html).toContain("<title>Tereo</title>");
  });

  it("escapes attribute values", () => {
    const html = injectBranding(
      SHELL,
      branding({ logoUrl: '/x"><script>alert(1)</script>' }),
      "auth"
    );
    expect(head(html)).toContain(
      'href="/x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'
    );
  });
});
