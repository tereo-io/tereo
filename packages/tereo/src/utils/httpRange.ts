/**
 * `Range: bytes=…` for a representation of `size` bytes (RFC 9110 §14).
 *
 * - `null`: serve the whole representation — no header, another unit, a
 *   malformed spec, or several ranges (multipart/byteranges isn't offered).
 * - `"unsatisfiable"`: answer 416.
 * - Otherwise the inclusive byte range to send, clamped to the content.
 */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const unit = /^\s*bytes\s*=(.*)$/i.exec(header);
  if (!unit) return null;
  const spec = unit[1].trim();
  if (spec.includes(",")) return null;
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts || (parts[1] === "" && parts[2] === "")) return null;
  const first = parts[1] === "" ? null : Number(parts[1]);
  const last = parts[2] === "" ? null : Number(parts[2]);
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  ) {
    return null;
  }

  if (first === null) {
    // Suffix range: the last `last` bytes.
    if (last === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - last!), end: size - 1 };
  }
  if (last !== null && last < first) return null;
  if (first >= size) return "unsatisfiable";
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/**
 * Whether `If-Range` lets a range through: an entity tag must match `etag`
 * strongly (a weak tag never does). A date must equal `lastModified` to the
 * second, and counts only as a strong validator (RFC 9110 §8.8.2.2): one at
 * least a second older than the response's `Date` (`now`), since the content
 * could change again within the second it names. Without the header there
 * is nothing to check.
 */
export function ifRangeAllows(
  header: string | undefined,
  etag: string,
  lastModified?: Date,
  now: Date = new Date()
): boolean {
  if (header === undefined) return true;
  const value = header.trim();
  if (value.startsWith("W/")) return false;
  if (value.startsWith('"')) return value === `"${etag}"`;
  const date = Date.parse(value);
  if (Number.isNaN(date) || !lastModified) return false;
  const modified = Math.floor(lastModified.getTime() / 1000);
  if (modified >= Math.floor(now.getTime() / 1000)) return false;
  return Math.floor(date / 1000) === modified;
}
