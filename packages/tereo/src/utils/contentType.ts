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
