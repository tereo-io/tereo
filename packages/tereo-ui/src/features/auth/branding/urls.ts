import env from "@/lib/env";

const coreOrigin = () => {
  try {
    return new URL(env.CORE_URL).origin;
  } catch {
    return null;
  }
};

/**
 * https: absolute, root-relative (never `//host` or `/\host`), or core's own
 * origin, which may be http: in local development. Never `javascript:` or
 * `data:`.
 */
export const isSafeUrl = (url: string | null | undefined): url is string => {
  if (!url) return false;
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
 * server, or a UI hosted apart from core).
 */
export const brandingImageUrl = (
  url: string | null | undefined
): string | null => {
  if (!isSafeUrl(url)) return null;
  return url.startsWith("/") ? new URL(url, env.CORE_URL).toString() : url;
};
