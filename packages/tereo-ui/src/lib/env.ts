// "/": core serves the build at its root, as the dev server does.
const BASE_URL = import.meta.env.BASE_URL;

// VITE_CORE_URL is a development override: the dev server (:4000) talks
// cross-origin to core (:4001). Unset, core is assumed to be served from the
// page's own origin, so a production build stays domain-agnostic.
const env = {
  CORE_URL: (import.meta.env.VITE_CORE_URL as string) || window.location.origin,
  // Must match `${UI_BASE_URL}/callback`, which core's seed registers on the
  // login client.
  REDIRECT_URI:
    (import.meta.env.VITE_REDIRECT_URI as string) ||
    `${window.location.origin}${BASE_URL}callback`,
  // Core seeds the login client under this fixed id (LOGIN_CLIENT in core's
  // definitions); override only to log in through a different client.
  CLIENT_ID: (import.meta.env.VITE_CLIENT_ID as string) || "tereo-ui",
  IS_DEV: import.meta.env.DEV as boolean,
  // The router's basename: "" (the app is at the root).
  BASE_PATH: BASE_URL.replace(/\/+$/, ""),
  // The app's root as a URL path, for full-page navigations.
  HOME_PATH: BASE_URL,
};

export default env;
