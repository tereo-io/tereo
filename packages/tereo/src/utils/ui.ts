import { trimTrailing } from "./strings.js";
import { fileURLToPath } from "url";

// Paths core keeps for itself; the admin UI, served at the root, owns
// everything else. The UI's `check` script keeps a copy of this list and
// refuses a route under any of these.
export const RESERVED_PREFIXES: readonly string[] = [
  "/v1",
  "/oauth",
  "/.well-known",
  "/health",
  "/ws",
  "/assets",
];

// Lowercased because Express matches routes case-insensitively: `/V1/...`
// still reaches the API.
export const isReservedPath = (path: string): boolean => {
  const lower = path.toLowerCase();
  return RESERVED_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`)
  );
};

// The UI's sign-in routes, which core serves with the client's branding
// injected; `/login/*` is branded too. The UI's `check` script fails when one
// of these is not a route.
export const BRANDED_AUTH_PATHS: readonly string[] = [
  "/login",
  "/consent",
  "/logout",
  "/set-password",
  "/forgot-password",
  "/verify-email",
];

// Lowercased and without a trailing slash, as the UI's router matches them.
export const isBrandedAuthPath = (path: string): boolean => {
  const lower = trimTrailing(path.toLowerCase(), "/");
  return BRANDED_AUTH_PATHS.includes(lower) || lower.startsWith("/login/");
};

// The UI's build output beside core in the monorepo, which is also where the
// Docker image puts it. Resolved from this file, so `src/` under tsx and
// `dist/` once compiled land on the same directory.
export const DEFAULT_UI_DIST_PATH = fileURLToPath(
  new URL("../../../tereo-ui/dist", import.meta.url)
);

const DEV_UI_BASE_URL = "http://localhost:4000";

/**
 * The UI's base URL, without a trailing slash. In production core serves the
 * UI itself, at `PUBLIC_URL`; elsewhere the default is the Vite dev server.
 */
export function resolveUiBaseUrl(source: {
  NODE_ENV?: string;
  PUBLIC_URL?: string;
  UI_BASE_URL?: string;
}): string {
  const fallback =
    source.NODE_ENV === "production"
      ? (source.PUBLIC_URL ?? "http://localhost:4001")
      : DEV_UI_BASE_URL;
  return (source.UI_BASE_URL || fallback).replace(/\/+$/, "");
}
