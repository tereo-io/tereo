// Core sends the browser on only to URIs registered on a client, but it
// registers any URL scheme, and these would run on this page's origin.
const SCRIPT_SCHEMES = new Set(["javascript:", "data:", "vbscript:"]);

export const isNavigableUrl = (url: string): boolean => {
  try {
    return !SCRIPT_SCHEMES.has(new URL(url, window.location.href).protocol);
  } catch {
    return false;
  }
};

/** Leaves the app for a URL core returned; throws for one that is unsafe. */
export const redirectTo = (url: string): void => {
  if (!isNavigableUrl(url)) {
    throw new Error("The application's redirect address is not allowed.");
  }
  window.location.assign(url);
};
