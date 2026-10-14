/**
 * Limits on a single-file upload's other parts. The upload routes read only
 * the `file` part (metadata and tags come as headers), so a few small stray
 * fields are tolerated and anything more is refused, rather than busboy's
 * defaults: unlimited fields of up to 1 MB each, buffered into `req.body`.
 */
export const SINGLE_FILE_FIELD_LIMITS = {
  fields: 10,
  fieldSize: 1024,
  parts: 11,
  headerPairs: 100,
} as const;

/** Multer codes for a request whose body is too big rather than malformed. */
export const TOO_LARGE_MULTER_CODES: ReadonlySet<string> = new Set([
  "LIMIT_FILE_SIZE",
  "LIMIT_FIELD_VALUE",
  "LIMIT_FIELD_COUNT",
  "LIMIT_PART_COUNT",
]);
