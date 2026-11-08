import type { BrandingProfile } from "../../../prisma/generated/client/index.js";
import { getByClientUuid, getDefault } from "../db/brandingProfiles.js";
import { LOGIN_CLIENT } from "../../definitions/loginClient.js";
import type { BrandingFields } from "./schema.js";
import { BoundedCache } from "../boundedCache.js";
import { prisma } from "../db/prisma.js";
import {
  broadcastBrandingInvalidate,
  onBrandingInvalidate,
} from "../cacheBroadcast.js";
import {
  type EffectiveBranding,
  type ProfileValues,
  mergeBranding,
} from "./merge.js";

// Every entry also expires, so a replica that missed an invalidation (a
// failed publish, or one sent while its subscriber was reconnecting) catches
// up within this.
const TTL_MS = 5 * 60_000;
const UNKNOWN_CLIENT_TTL_MS = 60_000;

// Clients that exist, by client_id, with their merged branding.
const known = new BoundedCache<EffectiveBranding | null>(1000, TTL_MS);
// Ids that matched no client. Kept apart, so a stream of made-up ids cannot
// evict real clients; they resolve to the default.
const unknown = new BoundedCache<true>(500, UNKNOWN_CLIENT_TTL_MS);

interface DefaultSlot {
  values: ProfileValues | null;
  branding: EffectiveBranding | null;
  expires: number;
}
let defaultSlot: DefaultSlot | null = null;

// Bumped by every clear so a load that raced an invalidation is not stored.
let generation = 0;

const clearCache = () => {
  generation++;
  known.clear();
  unknown.clear();
  defaultSlot = null;
};
onBrandingInvalidate(clearCache);

export const toValues = (
  profile: BrandingProfile,
  keys: Map<string, string>
): ProfileValues => ({
  appName: profile.appName,
  headline: profile.headline,
  subtitle: profile.subtitle,
  signInLabel: profile.signInLabel,
  notice: profile.notice,
  layout: profile.layout,
  footerLinks: profile.footerLinks as BrandingFields["footerLinks"],
  colorsLight: profile.colorsLight as Record<string, string>,
  colorsDark: profile.colorsDark as Record<string, string>,
  applyToConsole: profile.applyToConsole,
  logoKey: (profile.logoObjectId && keys.get(profile.logoObjectId)) || null,
  logoDarkKey:
    (profile.logoDarkObjectId && keys.get(profile.logoDarkObjectId)) || null,
  faviconKey:
    (profile.faviconObjectId && keys.get(profile.faviconObjectId)) || null,
  backgroundKey:
    (profile.backgroundObjectId && keys.get(profile.backgroundObjectId)) ||
    null,
});

/** Object keys of the live (not soft-deleted) images the profiles reference. */
export const liveKeys = async (profiles: BrandingProfile[]) => {
  const ids = new Set<string>();
  for (const p of profiles) {
    for (const id of [
      p.logoObjectId,
      p.logoDarkObjectId,
      p.faviconObjectId,
      p.backgroundObjectId,
    ]) {
      if (id) ids.add(id);
    }
  }
  const keys = new Map<string, string>();
  if (ids.size === 0) return keys;
  const objects = await prisma.object.findMany({
    where: { id: { in: [...ids] }, deletedAt: null },
    select: { id: true, objectKey: true },
  });
  for (const o of objects) keys.set(o.id, o.objectKey);
  return keys;
};

const loadDefault = async (): Promise<DefaultSlot> => {
  if (defaultSlot && defaultSlot.expires > Date.now()) return defaultSlot;
  const startedAt = generation;
  const profile = await getDefault();
  const values = profile ? toValues(profile, await liveKeys([profile])) : null;
  const slot = {
    values,
    branding: mergeBranding(null, values),
    expires: Date.now() + TTL_MS,
  };
  if (startedAt === generation) defaultSlot = slot;
  return slot;
};

/**
 * Effective branding for a sign-in page. Takes the raw query value: anything
 * but a string of 1-64 characters counts as no client. Unknown ids resolve to
 * the default, so they look like any unbranded client; each costs at most one
 * client lookup a minute. Database errors propagate and are never cached.
 */
export async function resolveBranding(
  clientId: unknown
): Promise<EffectiveBranding | null> {
  const id =
    typeof clientId === "string" &&
    clientId.length >= 1 &&
    clientId.length <= 64
      ? clientId
      : "";
  if (id === "" || unknown.get(id)) return (await loadDefault()).branding;
  const hit = known.get(id);
  if (hit !== undefined) return hit;

  const startedAt = generation;
  const client = await prisma.oAuthClient.findUnique({
    where: { clientId: id },
    select: { id: true },
  });
  if (!client) {
    if (startedAt === generation) unknown.set(id, true);
    return (await loadDefault()).branding;
  }
  const [own, fallback] = await Promise.all([
    getByClientUuid(client.id),
    loadDefault(),
  ]);
  const value = own
    ? mergeBranding(toValues(own, await liveKeys([own])), fallback.values)
    : fallback.branding;
  if (startedAt === generation) known.set(id, value);
  return value;
}

export const resolveConsoleBranding = () =>
  resolveBranding(LOGIN_CLIENT.clientId);

/** Call after any write to a profile: clears this process and every replica. */
export async function invalidateBranding(): Promise<void> {
  clearCache();
  await broadcastBrandingInvalidate();
}
