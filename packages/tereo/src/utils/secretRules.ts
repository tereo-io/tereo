import { randomBytes } from "crypto";

export const CLIENT_SECRET_PREFIX = "tereo_sk_";
export const CLIENT_SECRET_PATTERN = /^tereo_sk_[A-Za-z0-9_-]{43}$/;

const MIN_DISTINCT_CHARACTERS = 16;
const SEQUENCE_LENGTH = 6;

const FORMAT_MESSAGE =
  "must be tereo_sk_ followed by 43 base64url characters (generate one with npm run cli -- generate-secret)";
const RANDOM_MESSAGE =
  "does not look random; generate one with npm run cli -- generate-secret";

export const newClientSecretValue = (): string =>
  CLIENT_SECRET_PREFIX + randomBytes(32).toString("base64url");

// Longest stretch where each code point differs from the previous by `step`
// (0 = a repeated character, 1 = ascending, -1 = descending).
const longestRun = (body: string, step: number): number => {
  let longest = 1;
  let current = 1;
  for (let i = 1; i < body.length; i++) {
    current =
      body.charCodeAt(i) - body.charCodeAt(i - 1) === step ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
};

// Returns a message that never contains the value, or null when acceptable.
export const secretStrengthProblem = (value: string): string | null => {
  if (!CLIENT_SECRET_PATTERN.test(value)) return FORMAT_MESSAGE;

  const body = value.slice(CLIENT_SECRET_PREFIX.length);
  const lowEntropy =
    new Set(body).size < MIN_DISTINCT_CHARACTERS ||
    [0, 1, -1].some((step) => longestRun(body, step) >= SEQUENCE_LENGTH);
  return lowEntropy ? RANDOM_MESSAGE : null;
};
