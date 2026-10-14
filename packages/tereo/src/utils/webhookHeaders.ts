import { BadRequestError } from "./errors.js";

/**
 * Custom header values are often credentials, so they never leave core: API
 * responses and audit entries show each value as this placeholder.
 */
export const HEADER_VALUE_MASK = "********";

type Headers = Record<string, string>;

const asHeaders = (value: unknown): Headers | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Headers)
    : null;

export function maskCustomHeaders(value: unknown): Headers | null {
  const headers = asHeaders(value);
  if (!headers) return null;
  return Object.fromEntries(
    Object.keys(headers).map((name) => [name, HEADER_VALUE_MASK])
  );
}

/**
 * An update's headers with each placeholder replaced by the stored value, so
 * a client can send back what it read and keep the values it did not change.
 * Names match case-insensitively, as HTTP header names do. A placeholder for
 * a header that is not stored is refused rather than saved.
 */
export function resolveMaskedHeaders(
  incoming: Headers,
  stored: unknown
): Headers {
  const current = new Map(
    Object.entries(asHeaders(stored) ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ])
  );
  const unknown = Object.entries(incoming)
    .filter(
      ([name, value]) =>
        value === HEADER_VALUE_MASK && !current.has(name.toLowerCase())
    )
    .map(([name]) => name);
  if (unknown.length > 0) {
    throw new BadRequestError(
      "masked_header_value",
      `No stored value to keep for ${unknown.join(", ")}: send the header's real value.`
    );
  }
  return Object.fromEntries(
    Object.entries(incoming).map(([name, value]) => [
      name,
      value === HEADER_VALUE_MASK ? current.get(name.toLowerCase())! : value,
    ])
  );
}
