import env from "@/lib/env";

const coreOrigin = () => {
  try {
    return new URL(env.CORE_URL).origin;
  } catch {
    return null;
  }
};

// The URL parser drops tabs and newlines anywhere, so `/\t/evil.com` would
// become `//evil.com`; refuse every control character outright.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * https: absolute, root-relative (never `//host` or `/\host`), or core's own
 * origin, which may be http: in local development. Never `javascript:` or
 * `data:`.
 */
export const isSafeUrl = (url: string | null | undefined): url is string => {
  if (!url || CONTROL.test(url)) return false;
  if (url.startsWith("/")) return !/^\/[/\\]/.test(url);
  if (/^https:\/\//i.test(url)) return true;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.origin === coreOrigin();
  } catch {
    return false;
  }
};

/**
 * A branding image URL as the browser should load it. Core gives
 * root-relative paths under `/oauth/branding/assets/`, which resolve against
 * core, not the page: the UI may be served from another origin (the Vite dev
 * server, or a UI hosted apart from core). Only core's or the page's origin
 * is loaded.
 */
export const brandingImageUrl = (
  url: string | null | undefined
): string | null => {
  if (!isSafeUrl(url)) return null;
  let resolved: URL;
  try {
    resolved = new URL(url, env.CORE_URL);
  } catch {
    return null;
  }
  const allowed = [coreOrigin(), window.location.origin];
  return allowed.includes(resolved.origin) ? resolved.toString() : null;
};
