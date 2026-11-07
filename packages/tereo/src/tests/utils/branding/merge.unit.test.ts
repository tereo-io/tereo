// @module-tag unit
// @module-tag auth
import { describe, expect, it } from "vitest";
import {
  type ProfileValues,
  mergeBranding,
  mergeWithSources,
} from "../../../utils/branding/merge.js";

const profile = (over: Partial<ProfileValues> = {}): ProfileValues => ({
  appName: null,
  headline: null,
  subtitle: null,
  signInLabel: null,
  notice: null,
  layout: null,
  footerLinks: null,
  colorsLight: {},
  colorsDark: {},
  applyToConsole: false,
  logoKey: null,
  logoDarkKey: null,
  faviconKey: null,
  backgroundKey: null,
  ...over,
});

describe("mergeBranding", () => {
  it("returns null when neither profile exists", () => {
    expect(mergeBranding(null, null)).toBeNull();
  });

  it("prefers the client's value, and inherits where the client has none", () => {
    const merged = mergeBranding(
      profile({ appName: "Client", headline: null }),
      profile({ appName: "Default", headline: "Welcome", notice: "Hi" })
    );
    expect(merged?.appName).toBe("Client");
    expect(merged?.headline).toBe("Welcome");
    expect(merged?.notice).toBe("Hi");
    expect(merged?.subtitle).toBeNull();
  });

  it("merges colours key by key", () => {
    const merged = mergeBranding(
      profile({ colorsLight: { "--k-primary-color": "#111111" } }),
      profile({
        colorsLight: {
          "--k-primary-color": "#222222",
          "--k-text-color": "#333333",
        },
        colorsDark: { "--k-text-color": "#444444" },
      })
    );
    expect(merged?.colorsLight).toEqual({
      "--k-primary-color": "#111111",
      "--k-text-color": "#333333",
    });
    expect(merged?.colorsDark).toEqual({ "--k-text-color": "#444444" });
  });

  it("takes footerLinks whole from the client when it has any", () => {
    const clientLinks = [{ label: "A", url: "https://a.example" }];
    const defaultLinks = [
      { label: "B", url: "https://b.example" },
      { label: "C", url: "https://c.example" },
    ];
    expect(
      mergeBranding(
        profile({ footerLinks: clientLinks }),
        profile({ footerLinks: defaultLinks })
      )?.footerLinks
    ).toEqual(clientLinks);
    expect(
      mergeBranding(profile(), profile({ footerLinks: defaultLinks }))
        ?.footerLinks
    ).toEqual(defaultLinks);
  });

  it("turns image keys into asset URLs, client first", () => {
    const merged = mergeBranding(
      profile({ logoKey: "c.png" }),
      profile({ logoKey: "d.png", faviconKey: "f.png" })
    );
    expect(merged?.logoUrl).toBe("/oauth/branding/assets/c.png");
    expect(merged?.faviconUrl).toBe("/oauth/branding/assets/f.png");
    expect(merged?.logoDarkUrl).toBeNull();
  });

  it("reads applyToConsole from the client profile when there is one", () => {
    expect(
      mergeBranding(
        profile({ applyToConsole: false }),
        profile({ applyToConsole: true })
      )?.applyToConsole
    ).toBe(false);
    expect(
      mergeBranding(profile({ applyToConsole: true }), profile())
        ?.applyToConsole
    ).toBe(true);
  });

  it("reads applyToConsole from the default when there is no client profile", () => {
    expect(
      mergeBranding(null, profile({ applyToConsole: true }))?.applyToConsole
    ).toBe(true);
  });
});

describe("mergeWithSources", () => {
  it("reports where each slot and colour came from", () => {
    const { sources, colorSources } = mergeWithSources(
      profile({
        appName: "Client",
        colorsLight: { "--k-primary-color": "#111111" },
      }),
      profile({
        headline: "Welcome",
        logoKey: "d.png",
        colorsLight: {
          "--k-primary-color": "#222222",
          "--k-text-color": "#333333",
        },
      })
    );
    expect(sources.appName).toBe("client");
    expect(sources.headline).toBe("default");
    expect(sources.logo).toBe("default");
    expect(sources.subtitle).toBe("tereo");
    expect(sources.background).toBe("tereo");
    expect(colorSources.light).toEqual({
      "--k-primary-color": "client",
      "--k-text-color": "default",
    });
    expect(colorSources.dark).toEqual({});
  });
});
