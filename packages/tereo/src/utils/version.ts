import { readFileSync } from "node:fs";

/**
 * Core's version from its own package.json, found relative to this module
 * (`src/utils/` or `dist/utils/`), not `npm_package_version`: the image runs
 * `node` directly, so npm never sets it.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // Fall through to the placeholder.
  }
  return "0.0.0";
}

export const CORE_VERSION = readVersion();
