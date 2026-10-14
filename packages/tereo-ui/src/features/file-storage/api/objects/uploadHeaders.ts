/**
 * JSON for a header value, which must be ASCII (the browser refuses anything
 * past U+00FF): every character past `~` is written as a `\uXXXX` escape (an
 * emoji as its two surrogates), which core's `JSON.parse` reads back unchanged.
 */
export const asciiJson = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );

export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 128;

/** Why core would refuse `tags`, or `null`. */
export const tagsError = (tags: string[]): string | null => {
  if (tags.length > MAX_TAGS) {
    return `At most ${MAX_TAGS} tags per object (${tags.length} given)`;
  }
  const long = tags.find((t) => t.length > MAX_TAG_LENGTH);
  if (long !== undefined) {
    return `Tags are at most ${MAX_TAG_LENGTH} characters ("${long.slice(0, 20)}…" is ${long.length})`;
  }
  return null;
};

/**
 * `X-Tags` in its JSON-array form, ASCII-escaped like `X-Metadata`, so a tag
 * may hold any character, commas included.
 */
export const tagsHeader = (tags: string[]): string => asciiJson(tags);
