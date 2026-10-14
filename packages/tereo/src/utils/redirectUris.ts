// Schemes a browser runs or renders in the page that navigates to them. The
// login UI sends the browser to redirect URIs with `location.href`, so one of
// these would run in the UI's origin.
const SCRIPT_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "blob:",
  "file:",
]);

/** False for a URI that does not parse or uses a script-capable scheme. */
export const isSafeRedirectUri = (uri: string): boolean => {
  try {
    return !SCRIPT_SCHEMES.has(new URL(uri).protocol.toLowerCase());
  } catch {
    return false;
  }
};

export const UNSAFE_REDIRECT_URI_MESSAGE =
  "Redirect URI must not use a javascript:, data:, vbscript:, blob: or file: scheme";
