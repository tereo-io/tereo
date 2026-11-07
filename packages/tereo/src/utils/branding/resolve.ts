import type { BrandingProfile } from "../../../prisma/generated/client/index.js";
import { getByClientUuid, getDefault } from "../db/brandingProfiles.js";
import { LOGIN_CLIENT } from "../../definitions/loginClient.js";
import type { BrandingFields } from "./schema.js";
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

const MAX_ENTRIES = 1000;
const UNKNOWN_CLIENT_TTL_MS = 60_000;

interface Entry {
  value: EffectiveBranding | null;
  expires: number;
}

const cache = new Map<string, Entry>();
// Bumped by every clear so a load that raced an invalidation is not stored.
let generation = 0;

const clearCache = () => {
  generation++;
  cache.clear();
};
onBrandingInvalidate(clearCache);

const toValues = (
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
const liveKeys = async (profiles: BrandingProfile[]) => {
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

const load = async (
  clientId: string
): Promise<{ value: EffectiveBranding | null; knownClient: boolean }> => {
  const client = clientId
    ? await prisma.oAuthClient.findUnique({
        where: { clientId },
        select: { id: true },
      })
    : null;
  const [own, fallback] = await Promise.all([
    client ? getByClientUuid(client.id) : null,
    getDefault(),
  ]);
  const profiles = [own, fallback].filter((p): p is BrandingProfile => !!p);
  const keys = await liveKeys(profiles);
  return {
    value: mergeBranding(
      own ? toValues(own, keys) : null,
      fallback ? toValues(fallback, keys) : null
    ),
    knownClient: client !== null,
  };
};

/**
 * Effective branding for a sign-in page. Takes the raw query value: anything
 * but a string of 1-64 characters counts as no client. Unknown ids resolve to
 * the default and are cached briefly, so they look like any unbranded client.
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
  const hit = cache.get(id);
  if (hit && hit.expires > Date.now()) return hit.value;

  const startedAt = generation;
  const { value, knownClient } = await load(id);
  if (startedAt === generation) {
    cache.delete(id);
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(id, {
      value,
      expires:
        id === "" || knownClient
          ? Number.POSITIVE_INFINITY
          : Date.now() + UNKNOWN_CLIENT_TTL_MS,
    });
  }
  return value;
}

export const resolveConsoleBranding = () =>
  resolveBranding(LOGIN_CLIENT.clientId);

/** Call after any write to a profile: clears this process and every replica. */
export async function invalidateBranding(): Promise<void> {
  clearCache();
  await broadcastBrandingInvalidate();
}
