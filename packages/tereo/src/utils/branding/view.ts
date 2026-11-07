import type { BrandingProfile } from "../../../prisma/generated/client/index.js";
import { type EffectiveBranding, mergeWithSources } from "./merge.js";
import { liveKeys, toValues } from "./resolve.js";
import { brandingAssetUrl } from "./images.js";
import db from "../db/index.js";

const EMPTY_EFFECTIVE: EffectiveBranding = {
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

const image = (key: string | null) =>
  key
    ? { sha256: key.slice(0, key.indexOf(".")), url: brandingAssetUrl(key) }
    : null;

/**
 * A profile as the admin API returns it: its own values, the effective
 * branding with a source per slot and colour, and `inherited`, what applies
 * beneath its own layer (the default for a client, stock for the default).
 */
export const profileView = async (
  client: { id: string; clientId: string; name: string } | null,
  access: { canEdit: boolean; canManageGrants: boolean }
) => {
  const [own, defaultProfile] = await Promise.all([
    client ? db.brandingProfiles.getByClientUuid(client.id) : null,
    db.brandingProfiles.getDefault(),
  ]);
  const self = client ? own : defaultProfile;
  const under = client ? defaultProfile : null;
  const keys = await liveKeys(
    [self, under].filter((p): p is BrandingProfile => !!p)
  );
  const selfValues = self ? toValues(self, keys) : null;
  const underValues = under ? toValues(under, keys) : null;
  const merged = client
    ? mergeWithSources(selfValues, underValues)
    : mergeWithSources(null, selfValues);
  const inherited = client ? mergeWithSources(null, underValues).values : null;

  const ownView = selfValues && {
    appName: selfValues.appName,
    headline: selfValues.headline,
    subtitle: selfValues.subtitle,
    signInLabel: selfValues.signInLabel,
    notice: selfValues.notice,
    layout: selfValues.layout,
    footerLinks: selfValues.footerLinks,
    colorsLight: selfValues.colorsLight,
    colorsDark: selfValues.colorsDark,
    applyToConsole: selfValues.applyToConsole,
    logo: image(selfValues.logoKey),
    logoDark: image(selfValues.logoDarkKey),
    favicon: image(selfValues.faviconKey),
    background: image(selfValues.backgroundKey),
  };

  const provisioned = self?.provisioned ?? false;
  return {
    client: client && {
      id: client.id,
      clientId: client.clientId,
      name: client.name,
    },
    own: ownView,
    effective: merged.values ?? EMPTY_EFFECTIVE,
    inherited,
    sources: merged.sources,
    colorSources: merged.colorSources,
    provisioned,
    provisionedFrom: self?.provisionedFrom ?? null,
    updatedAt: self?.updatedAt ?? null,
    canEdit: access.canEdit && !provisioned,
    canManageGrants: access.canManageGrants,
  };
};
