import type { Attributes, Span } from "@opentelemetry/api";

/**
 * Keeps credentials out of exported spans. URLs carry them in the query
 * (`sig`, presigned S3 signatures, the login flow's `session`) and in share
 * links' path (`/v1/files/shared/<token>`); Redis commands carry them as keys and
 * arguments.
 */

// Express routes case-insensitively, so `/SHARED/<token>` reaches the share
// routes too.
const TOKEN_SEGMENT = /(\/shared\/)[^/?#]+/i;

/** The URL or path without its query, fragment and share token. */
export const redactUrl = (url: string): string =>
  url.split(/[?#]/, 1)[0].replace(TOKEN_SEGMENT, "$1:token");

const URL_ATTRIBUTES = ["http.url", "http.target", "url.full", "url.path"];

/**
 * instrumentation-http `requestHook`, which runs once the span holds its
 * attributes: rewrites the URL ones. The SDK's spans expose `attributes`.
 */
export const redactHttpSpan = (span: Span): void => {
  const attributes = (span as Span & { attributes?: Attributes }).attributes;
  if (!attributes) return;
  for (const name of URL_ATTRIBUTES) {
    const value = attributes[name];
    if (typeof value === "string") span.setAttribute(name, redactUrl(value));
  }
  if (attributes["url.query"] !== undefined) {
    span.setAttribute("url.query", "[redacted]");
  }
};

/**
 * instrumentation-undici `requestHook`, for core's outbound `fetch` (webhook
 * deliveries, OIDC). Those URLs are someone else's, and a webhook URL often
 * carries its secret in the path (`/services/T0/B0/<secret>`), so the span
 * keeps the origin alone. The hook runs once the URL attributes are set.
 */
export const redactClientSpan = (span: Span): void => {
  const attributes = (span as Span & { attributes?: Attributes }).attributes;
  if (!attributes) return;
  const full = attributes["url.full"];
  if (typeof full === "string") {
    let origin = "[redacted]";
    try {
      // `origin` also drops any user:password@.
      origin = new URL(full).origin;
    } catch {
      // Not parseable: keep nothing of it.
    }
    span.setAttribute("url.full", origin);
  }
  if (attributes["url.path"] !== undefined) {
    span.setAttribute("url.path", "[redacted]");
  }
  if (attributes["url.query"]) {
    span.setAttribute("url.query", "[redacted]");
  }
};

/** instrumentation-ioredis `dbStatementSerializer`: the command name only. */
export const redisStatement = (cmdName: string): string => cmdName;
