import { BadRequestError } from "./errors.js";

// RFC 9110 token characters; notably no comma, semicolon, space or quote.
const TOKEN = "[a-z0-9!#$%&'*+.^_`|~-]+";
const MEDIA_TYPE = new RegExp(`^(${TOKEN})/(${TOKEN})$`, "i");
const CHARSET = new RegExp(`^charset=(${TOKEN})$`, "i");

/**
 * The stored form of an object's content type: `type/subtype`, lowercased,
 * with at most a `charset` parameter. Null for anything else — a list of
 * types, other parameters, stray characters. A browser reads
 * `image/png, text/html` as HTML, so nothing looser can be stored or trusted.
 */
export const normalizeContentType = (raw: string): string | null => {
  const [type, ...params] = raw.split(";").map((part) => part.trim());
  const media = MEDIA_TYPE.exec(type);
  if (!media) return null;
  const mediaType = `${media[1]}/${media[2]}`.toLowerCase();
  if (params.length === 0) return mediaType;
  if (params.length > 1) return null;
  const charset = CHARSET.exec(params[0]);
  if (!charset) return null;
  return `${mediaType}; charset=${charset[1].toLowerCase()}`;
};

/** `normalizeContentType`, refusing what it can't normalize. */
export const parseContentType = (raw: string): string => {
  const normalized = raw.length <= 255 ? normalizeContentType(raw) : null;
  if (!normalized) {
    throw new BadRequestError(
      "invalid_content_type",
      "Content type must be a single type/subtype, optionally with a charset, of 255 characters or fewer"
    );
  }
  return normalized;
};

// Every type a browser runs as a script (the WHATWG "JavaScript MIME type"
// list), classic, module or worker. An upload may declare any of them: the
// upload check accepts whatever text a client calls it.
const JAVASCRIPT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

const PLAIN_TEXT = "text/plain; charset=utf-8";

/**
 * The `Content-Type` a download of an object stored as `stored` is sent
 * with: the stored type, but plain text for a JavaScript one. With `nosniff`
 * a browser then refuses the response as a script, so an uploaded file can't
 * be loaded by `<script src>` from a page on core's origin, where the
 * download's own disposition and CSP don't apply. A stored list of types
 * counts as JavaScript when any of them is.
 */
export const downloadContentType = (stored: string): string =>
  stored
    .split(",")
    .some((type) =>
      JAVASCRIPT_TYPES.has(type.split(";")[0].trim().toLowerCase())
    )
    ? PLAIN_TEXT
    : stored;
