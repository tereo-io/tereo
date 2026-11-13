import type { RequestHandler } from "express";
import {
  hostHeaderValidation as mcpHostHeaderValidation,
  originValidation as mcpOriginValidation,
} from "@modelcontextprotocol/express";

// The return types are spelled out so the emitted declarations name Express
// alone: a type from @modelcontextprotocol/express there would bring its
// req.auth declaration into the importing app.

/** `entry` as a URL when it is an http or https origin, with no path. */
export const parseOrigin = (entry: string): URL | undefined => {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return undefined;
  }
  const isOrigin =
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  return isOrigin ? url : undefined;
};

export const originHostname = (origin: string): string =>
  new URL(origin).hostname;

// The MCP SDK compares an entry with the request's hostname as URL parsing
// normalizes it, so an entry that parsing would change could never match.
const isHostname = (entry: string): boolean => {
  try {
    return new URL(`http://${entry}`).hostname === entry;
  } catch {
    return false;
  }
};

const WILDCARD_SCHEME = /^[a-z][a-z0-9+.-]*:\/\/\*$/;

/**
 * Refuses a request whose Host is missing or not listed. `allowedHostnames`
 * holds hostnames as URL parsing writes them (`mcp.example.com`, `[::1]`):
 * no scheme, port or path. Throws for any other entry.
 */
export const hostHeaderValidation = (
  allowedHostnames: readonly string[]
): RequestHandler => {
  for (const entry of allowedHostnames) {
    if (!isHostname(entry)) {
      throw new Error(
        `hostHeaderValidation: ${JSON.stringify(entry)} is not a hostname such as "mcp.example.com"`
      );
    }
  }
  return mcpHostHeaderValidation([...allowedHostnames]);
};

/**
 * Refuses a browser request whose Origin is not listed or cannot be parsed;
 * a request without one passes. Each of `allowedOrigins` is an http or https
 * origin as `createTereoMcp`'s `allowedOrigins` takes it (compared by
 * hostname, as `listen` does), a hostname, or `<scheme>://*` for every
 * origin of a non-web scheme. Throws for any other entry.
 */
export const originValidation = (
  allowedOrigins: readonly string[]
): RequestHandler => {
  const hostnames = allowedOrigins.map((entry) => {
    // These parse as origins with the hostname "*", which no Origin has; the
    // MCP SDK honours a wildcard only for a non-web scheme.
    const webWildcard = entry === "http://*" || entry === "https://*";
    if (!webWildcard && parseOrigin(entry)) return originHostname(entry);
    if (isHostname(entry) || (WILDCARD_SCHEME.test(entry) && !webWildcard)) {
      return entry;
    }
    throw new Error(
      `originValidation: ${JSON.stringify(entry)} is not an origin such as "https://app.example.com", a hostname such as "app.example.com", or "<scheme>://*"`
    );
  });
  return mcpOriginValidation(hostnames);
};
