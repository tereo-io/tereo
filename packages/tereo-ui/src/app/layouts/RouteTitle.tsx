import { formatDocumentTitle } from "@/hooks/useDocumentTitle";
import { useMatches } from "react-router-dom";
import { useEffect } from "react";

interface RouteHandle {
  title?: string;
}

/** "oauth-clients" -> "Oauth Clients" */
const titleizeSegment = (segment: string) =>
  segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/**
 * Derive a title from the deepest matched route's path, ignoring URL params
 * (so a detail page like `/users/<uuid>` falls back to its list segment,
 * "Users", rather than the raw id — the detail page then overrides via
 * `useDocumentTitle(entity.name)`).
 */
const deriveTitleFromPath = (
  pathname: string,
  params: Record<string, string | undefined>
) => {
  const paramValues = new Set(Object.values(params).filter(Boolean));
  const segment = pathname
    .split("/")
    .filter(Boolean)
    .reverse()
    .find((seg) => !paramValues.has(seg));
  return segment ? titleizeSegment(segment) : undefined;
};

/**
 * Sets the browser tab title from the deepest matched route's `handle.title`
 * (e.g. `{ title: "My Account" }`); when no handle is present it falls back to a
 * title derived from the route path, so any route gets a sensible title without
 * explicit wiring. Add an explicit `handle.title` only where the derived casing
 * is wrong (e.g. "OAuth Clients", "API Docs").
 *
 * Rendered before `<Outlet />` in RootLayout so its effect runs before the
 * routed page's — a detail page calling `useDocumentTitle(entity.name)` then
 * overrides this static title with the loaded entity name. Renders nothing.
 */
export const RouteTitle = () => {
  const matches = useMatches();

  const handleTitle = [...matches]
    .reverse()
    .map((m) => (m.handle as RouteHandle | undefined)?.title)
    .find((t): t is string => Boolean(t));

  const deepest = matches[matches.length - 1];
  const title =
    handleTitle ??
    (deepest
      ? deriveTitleFromPath(deepest.pathname, deepest.params)
      : undefined);

  useEffect(() => {
    document.title = formatDocumentTitle(title);
  }, [title]);

  return null;
};
