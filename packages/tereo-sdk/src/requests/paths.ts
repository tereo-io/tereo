import { InvalidRequestInputError } from "../utils/errors.js";

/** A path fragment already escaped, which `urlPath` inserts as it is. */
export interface EncodedPath {
  readonly encoded: string;
}

/**
 * One path segment, escaped. An empty, `.` or `..` segment is refused: the
 * URL parser would drop or collapse it (`%2E` included), sending the request
 * to a different route.
 */
export const pathSegment = (value: string | number): string => {
  const segment = String(value);
  if (segment === "" || segment === "." || segment === "..") {
    throw new InvalidRequestInputError(
      `Path parameter ${JSON.stringify(segment)} cannot be sent in a URL`
    );
  }
  return encodeURIComponent(segment);
};

/**
 * Builds a request path, escaping each interpolated value as one segment:
 * urlPath`/v1/files/buckets/${bucket}` keeps a `/`, `?` or `#` in `bucket`
 * inside its segment.
 */
export const urlPath = (
  strings: TemplateStringsArray,
  ...values: (string | number | EncodedPath)[]
): string =>
  strings.reduce((out, literal, i) => {
    if (i >= values.length) return out + literal;
    const value = values[i];
    return (
      out +
      literal +
      (typeof value === "object" ? value.encoded : pathSegment(value))
    );
  }, "");
