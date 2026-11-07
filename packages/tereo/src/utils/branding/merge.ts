import type { BrandingFields } from "./schema.js";

export interface ProfileValues extends BrandingFields {
  logoKey: string | null;
  logoDarkKey: string | null;
  faviconKey: string | null;
  backgroundKey: string | null;
}

export interface EffectiveBranding {
  appName: string | null;
  headline: string | null;
  subtitle: string | null;
  signInLabel: string | null;
  notice: string | null;
  layout: "centered" | "split" | null;
  footerLinks: { label: string; url: string }[] | null;
  colorsLight: Record<string, string>;
  colorsDark: Record<string, string>;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  backgroundUrl: string | null;
  applyToConsole: boolean;
}

export type Source = "client" | "default" | "tereo";

// Same shape as brandingAssetUrl in images.ts.
const assetUrl = (key: string | null) =>
  key ? `/oauth/branding/assets/${key}` : null;

const SCALAR_SLOTS = [
  "appName",
  "headline",
  "subtitle",
  "signInLabel",
  "notice",
  "layout",
  "footerLinks",
] as const;

const IMAGE_SLOTS = [
  ["logo", "logoKey", "logoUrl"],
  ["logoDark", "logoDarkKey", "logoDarkUrl"],
  ["favicon", "faviconKey", "faviconUrl"],
  ["background", "backgroundKey", "backgroundUrl"],
] as const;

export function mergeWithSources(
  client: ProfileValues | null,
  fallback: ProfileValues | null
): {
  values: EffectiveBranding | null;
  sources: Record<string, Source>;
  colorSources: {
    light: Record<string, Source>;
    dark: Record<string, Source>;
  };
} {
  const sources: Record<string, Source> = {};
  const colorSources = {
    light: {} as Record<string, Source>,
    dark: {} as Record<string, Source>,
  };
  const layers: [Source, ProfileValues][] = [];
  if (client) layers.push(["client", client]);
  if (fallback) layers.push(["default", fallback]);

  const values = {
    colorsLight: {} as Record<string, string>,
    colorsDark: {} as Record<string, string>,
  } as Record<string, unknown> & EffectiveBranding;

  for (const slot of SCALAR_SLOTS) {
    const layer = layers.find(([, profile]) => profile[slot] !== null);
    (values as Record<string, unknown>)[slot] = layer ? layer[1][slot] : null;
    sources[slot] = layer ? layer[0] : "tereo";
  }
  for (const [slot, keyField, urlField] of IMAGE_SLOTS) {
    const layer = layers.find(([, profile]) => profile[keyField] !== null);
    values[urlField] = assetUrl(layer ? layer[1][keyField] : null);
    sources[slot] = layer ? layer[0] : "tereo";
  }

  // Lowest precedence first, so the client overwrites the default.
  for (const [source, profile] of [...layers].reverse()) {
    for (const [mode, target, from] of [
      ["light", values.colorsLight, profile.colorsLight],
      ["dark", values.colorsDark, profile.colorsDark],
    ] as const) {
      for (const [name, value] of Object.entries(from)) {
        target[name] = value;
        colorSources[mode][name] = source;
      }
    }
  }

  // Read from the profile that applies to the console: its own, else the default.
  values.applyToConsole = (client ?? fallback)?.applyToConsole ?? false;

  return {
    values: layers.length === 0 ? null : values,
    sources,
    colorSources,
  };
}

export function mergeBranding(
  client: ProfileValues | null,
  fallback: ProfileValues | null
): EffectiveBranding | null {
  return mergeWithSources(client, fallback).values;
}
