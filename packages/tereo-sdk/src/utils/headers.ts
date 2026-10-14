import { InvalidRequestInputError } from "./errors.js";

/**
 * JSON for a header value, which must be ASCII: every character past `~` is
 * written as a `\uXXXX` escape (an emoji as its two surrogates), which
 * `JSON.parse` reads back unchanged.
 */
export const asciiJson = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );

const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 128;

/**
 * Tags for `X-Tags` in its JSON-array form, ASCII-escaped like `X-Metadata`,
 * so a tag may hold any character, commas included. Each is trimmed and
 * empty ones dropped; at most 50 of up to 128 characters, as core allows.
 */
export const tagsHeader = (tags: string[]): string => {
  const trimmed = tags.map((t) => t.trim()).filter((t) => t.length > 0);
  if (trimmed.length > MAX_TAGS) {
    throw new InvalidRequestInputError(
      `At most ${MAX_TAGS} tags per object, got ${trimmed.length}`
    );
  }
  const long = trimmed.find((t) => t.length > MAX_TAG_LENGTH);
  if (long !== undefined) {
    throw new InvalidRequestInputError(
      `Tag ${JSON.stringify(long.slice(0, 20))}… is over ${MAX_TAG_LENGTH} characters`
    );
  }
  return asciiJson(trimmed);
};
