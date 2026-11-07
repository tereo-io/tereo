import { useEffect } from "react";

/** App name shown in the browser tab; used as the suffix and the bare default. */
const DEFAULT_APP_NAME = "Tereo";

let brandedName: string | null = null;

/** Console branding renames the tab suffix; the app layer sets it once from the injected block. */
export const setDocumentAppName = (name: string | null) => {
  brandedName = name;
};

const appName = () => brandedName ?? DEFAULT_APP_NAME;

/** Format a page title for the browser tab: `"<page> · Tereo"`, or the
 * bare app name when no/empty page title is given. */
export const formatDocumentTitle = (pageTitle?: string | null) =>
  pageTitle ? `${pageTitle} · ${appName()}` : appName();

/**
 * Sets `document.title` to `"<pageTitle> · Tereo"` while the calling
 * component is mounted, and restores it to the bare app name on unmount.
 *
 * Use this for titles that depend on fetched data — e.g. a detail page passing
 * the loaded entity name (`user?.email`). For static page titles, prefer the
 * route's `handle.title` (read centrally by `<RouteTitle />`) instead of calling
 * this hook. A nullish `pageTitle` (e.g. while the entity is still loading)
 * renders just `"Tereo"`, then updates once the value arrives.
 *
 * `<RouteTitle />` renders before the routed page, so its effect runs first and
 * this hook (in the page) wins — the entity name overrides the static handle.
 */
const useDocumentTitle = (pageTitle?: string | null) => {
  useEffect(() => {
    document.title = formatDocumentTitle(pageTitle);
    return () => {
      document.title = appName();
    };
  }, [pageTitle]);
};

export default useDocumentTitle;
